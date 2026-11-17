require("dotenv").config();

const express = require("express");
const cors = require("cors");

const { createClient } = require("@supabase/supabase-js");
const {
  AccessToken,
  RoomServiceClient,
} = require("livekit-server-sdk");

const app = express();

// ==================================================
// SERVER CONFIGURATION
// ==================================================

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);

    const allowedOrigins = (process.env.APP_ORIGINS || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);

    if (
      allowedOrigins.length === 0 ||
      allowedOrigins.includes(origin)
    ) {
      return callback(null, true);
    }

    return callback(new Error("Origin not allowed"));
  },
}));

app.use(express.json());

// ==================================================
// ENVIRONMENT VALIDATION
// ==================================================

const requiredEnv = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "LIVEKIT_API_KEY",
  "LIVEKIT_API_SECRET",
  "LIVEKIT_URL",
];

for (const key of requiredEnv) {
  if (!process.env[key]) {
    console.error(`Missing environment variable: ${key}`);
  }
}

// ==================================================
// LIVEKIT TRACK CONSTANTS
// ==================================================

// LiveKit TrackType.AUDIO = 0
const LIVEKIT_AUDIO_TRACK_TYPE = 0;

// LiveKit TrackSource values
const LIVEKIT_TRACK_SOURCE = {
  CAMERA: 1,
  MICROPHONE: 2,
  SCREEN_SHARE: 3,
  SCREEN_SHARE_AUDIO: 4,
};

// When muted, a speaker can still publish video.
const SPEAKER_MUTED_SOURCES = [
  LIVEKIT_TRACK_SOURCE.CAMERA,
  LIVEKIT_TRACK_SOURCE.SCREEN_SHARE,
];

// When unmuted, a speaker can publish audio and video.
const SPEAKER_UNMUTED_SOURCES = [
  LIVEKIT_TRACK_SOURCE.CAMERA,
  LIVEKIT_TRACK_SOURCE.MICROPHONE,
  LIVEKIT_TRACK_SOURCE.SCREEN_SHARE,
  LIVEKIT_TRACK_SOURCE.SCREEN_SHARE_AUDIO,
];

// ==================================================
// SUPABASE ADMIN CLIENT
// ==================================================

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  }
);

// ==================================================
// LIVEKIT ROOM SERVICE
// ==================================================

const liveKitHttpUrl = (process.env.LIVEKIT_URL || "")
  .replace(/^wss:/, "https:")
  .replace(/^ws:/, "http:");

const roomService = new RoomServiceClient(
  liveKitHttpUrl,
  process.env.LIVEKIT_API_KEY,
  process.env.LIVEKIT_API_SECRET
);

// ==================================================
// AUTHENTICATE SUPABASE USER
// ==================================================

async function authenticateUser(req, res) {
  const authorization = req.headers.authorization || "";

  if (!authorization.startsWith("Bearer ")) {
    res.status(401).json({
      error: "Authentication required",
    });

    return null;
  }

  const accessToken = authorization.substring(7);

  const {
    data: { user },
    error,
  } = await supabaseAdmin.auth.getUser(accessToken);

  if (error || !user) {
    res.status(401).json({
      error: "Invalid or expired login session",
    });

    return null;
  }

  return user;
}

// ==================================================
// GET ACTIVE LIVE STREAM
// ==================================================

async function getActiveStream(streamId) {
  const { data, error } = await supabaseAdmin
    .from("live_streams")
    .select("id, user_id, title, status, is_active")
    .eq("id", streamId)
    .eq("status", "live")
    .eq("is_active", true)
    .maybeSingle();

  if (error) {
    console.error("STREAM LOOKUP ERROR:", error);
    throw new Error("Unable to verify live session");
  }

  return data;
}

// ==================================================
// GET HOST-OWNED SPEAKER REQUEST
// ==================================================

async function getHostSpeakerRequest(requestId, user) {
  const { data: request, error } = await supabaseAdmin
    .from("live_speaker_requests")
    .select(
      "id, stream_id, user_id, status, host_muted, host_muted_track_sids"
    )
    .eq("id", requestId)
    .maybeSingle();

  if (error) throw error;

  if (!request) {
    return {
      error: "Speaker request not found",
    };
  }

  const stream = await getActiveStream(request.stream_id);

  if (!stream) {
    return {
      error: "Live session not found or has ended",
    };
  }

  if (stream.user_id !== user.id) {
    return {
      error: "Only the host can manage speaker requests",
    };
  }

  return {
    request,
    stream,
  };
}

// ==================================================
// HEALTH CHECK
// ==================================================

app.get("/", (req, res) => {
  res.status(200).send("Nasara LiveKit server running");
});

// ==================================================
// CREATE LIVEKIT TOKEN
//
// HOST = PUBLISH
// APPROVED SPEAKER = PUBLISH
// NORMAL VIEWER = WATCH ONLY
//
// MUTED SPEAKER:
// - Camera remains allowed.
// - Microphone publishing is blocked.
// ==================================================

app.post("/token", async (req, res) => {
  try {
    if (
      !process.env.LIVEKIT_API_KEY ||
      !process.env.LIVEKIT_API_SECRET ||
      !process.env.LIVEKIT_URL
    ) {
      return res.status(500).json({
        error: "LiveKit server configuration is incomplete",
      });
    }

    const user = await authenticateUser(req, res);
    if (!user) return;

    const { streamId } = req.body;

    if (!streamId) {
      return res.status(400).json({
        error: "Stream ID is required",
      });
    }

    const stream = await getActiveStream(streamId);

    if (!stream) {
      return res.status(404).json({
        error: "Live session not found or has ended",
      });
    }

    const isHost = stream.user_id === user.id;

    let isApprovedSpeaker = false;
    let speakerMuted = false;

    if (!isHost) {
      const { data: speakerRequest, error } = await supabaseAdmin
        .from("live_speaker_requests")
        .select("id, status, host_muted")
        .eq("stream_id", stream.id)
        .eq("user_id", user.id)
        .eq("status", "approved")
        .maybeSingle();

      if (error) {
        console.error("SPEAKER PERMISSION ERROR:", error);

        return res.status(500).json({
          error: "Unable to verify speaker permission",
        });
      }

      isApprovedSpeaker = !!speakerRequest;

      speakerMuted =
        isApprovedSpeaker &&
        speakerRequest.host_muted === true;
    }

    const canPublish = isHost || isApprovedSpeaker;

    const roomName = `nasara-${stream.id}`;

    const token = new AccessToken(
      process.env.LIVEKIT_API_KEY,
      process.env.LIVEKIT_API_SECRET,
      {
        identity: user.id,
        ttl: isHost ? "10m" : "2m",
      }
    );

    const grant = {
      roomJoin: true,
      room: roomName,
      canPublish,
      canSubscribe: true,
    };

    // Restrict approved speakers to the appropriate sources.
    if (isApprovedSpeaker) {
      grant.canPublishSources = speakerMuted
        ? SPEAKER_MUTED_SOURCES
        : SPEAKER_UNMUTED_SOURCES;
    }

    token.addGrant(grant);

    const jwt = await token.toJwt();

    return res.status(200).json({
      token: jwt,
      url: process.env.LIVEKIT_URL,
      roomName,
      role: isHost
        ? "host"
        : isApprovedSpeaker
          ? "speaker"
          : "viewer",
      canPublish,
      hostMuted: speakerMuted,
    });

  } catch (error) {
    console.error("LIVEKIT TOKEN ERROR:", error);

    return res.status(500).json({
      error: "Unable to create LiveKit access token",
    });
  }
});

// ==================================================
// VIEWER: REQUEST TO SPEAK
// POST /speaker/request
// ==================================================

app.post("/speaker/request", async (req, res) => {
  try {
    const user = await authenticateUser(req, res);
    if (!user) return;

    const { streamId } = req.body;

    if (!streamId) {
      return res.status(400).json({
        error: "Stream ID is required",
      });
    }

    const stream = await getActiveStream(streamId);

    if (!stream) {
      return res.status(404).json({
        error: "Live session not found or has ended",
      });
    }

    if (stream.user_id === user.id) {
      return res.status(400).json({
        error: "The host cannot request to speak",
      });
    }

    const { data: existing, error: lookupError } =
      await supabaseAdmin
        .from("live_speaker_requests")
        .select("id, status")
        .eq("stream_id", stream.id)
        .eq("user_id", user.id)
        .maybeSingle();

    if (lookupError) throw lookupError;

    if (existing?.status === "approved") {
      return res.status(200).json({
        message: "You are already approved to speak",
        request: existing,
      });
    }

    if (existing?.status === "pending") {
      return res.status(200).json({
        message: "Your request is already pending",
        request: existing,
      });
    }

    let request;

    if (existing?.status === "rejected") {
      const { data, error } = await supabaseAdmin
        .from("live_speaker_requests")
        .update({
          status: "pending",
          host_muted: false,
          host_muted_track_sids: [],
          updated_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
        })
        .eq("id", existing.id)
        .select("id, stream_id, user_id, status, created_at")
        .single();

      if (error) throw error;

      request = data;
    } else {
      const { data, error } = await supabaseAdmin
        .from("live_speaker_requests")
        .insert({
          stream_id: stream.id,
          user_id: user.id,
          status: "pending",
        })
        .select("id, stream_id, user_id, status, created_at")
        .single();

      if (error) throw error;

      request = data;
    }

    return res.status(201).json({
      message: "Request to speak sent",
      request,
    });

  } catch (error) {
    console.error("SPEAKER REQUEST ERROR:", error);

    return res.status(500).json({
      error: "Unable to send speaker request",
    });
  }
});

// ==================================================
// VIEWER: CHECK OWN SPEAKER REQUEST STATUS
// GET /speaker/status?streamId=...
// ==================================================

app.get("/speaker/status", async (req, res) => {
  try {
    const user = await authenticateUser(req, res);
    if (!user) return;

    const streamId = req.query.streamId;

    if (!streamId) {
      return res.status(400).json({
        error: "Stream ID is required",
      });
    }

    const stream = await getActiveStream(streamId);

    if (!stream) {
      return res.status(404).json({
        error: "Live session not found or has ended",
      });
    }

    if (stream.user_id === user.id) {
      return res.status(400).json({
        error: "The host does not need speaker approval",
      });
    }

    const { data, error } = await supabaseAdmin
      .from("live_speaker_requests")
      .select("id, stream_id, user_id, status, created_at, updated_at")
      .eq("stream_id", stream.id)
      .eq("user_id", user.id)
      .maybeSingle();

    if (error) {
      console.error("SPEAKER STATUS ERROR:", error);
      throw error;
    }

    return res.status(200).json({
      request: data || null,
    });

  } catch (error) {
    console.error("GET SPEAKER STATUS ERROR:", error);

    return res.status(500).json({
      error: "Unable to check speaker request status",
    });
  }
});

// ==================================================
// HOST: VIEW PENDING SPEAKER REQUESTS
// GET /speaker/requests?streamId=...
// ==================================================

app.get("/speaker/requests", async (req, res) => {
  try {
    const user = await authenticateUser(req, res);
    if (!user) return;

    const streamId = req.query.streamId;

    if (!streamId) {
      return res.status(400).json({
        error: "Stream ID is required",
      });
    }

    const stream = await getActiveStream(streamId);

    if (!stream) {
      return res.status(404).json({
        error: "Live session not found or has ended",
      });
    }

    if (stream.user_id !== user.id) {
      return res.status(403).json({
        error: "Only the host can view speaker requests",
      });
    }

    const { data, error } = await supabaseAdmin
      .from("live_speaker_requests")
      .select("id, stream_id, user_id, status, created_at")
      .eq("stream_id", stream.id)
      .eq("status", "pending")
      .order("created_at", { ascending: true });

    if (error) throw error;

    return res.status(200).json({
      requests: data || [],
    });

  } catch (error) {
    console.error("GET SPEAKER REQUESTS ERROR:", error);

    return res.status(500).json({
      error: "Unable to load speaker requests",
    });
  }
});

// ==================================================
// HOST: VIEW ALL APPROVED SPEAKERS
// GET /speaker/approved?streamId=...
// ==================================================

app.get("/speaker/approved", async (req, res) => {
  try {
    const user = await authenticateUser(req, res);
    if (!user) return;

    const streamId = req.query.streamId;

    if (!streamId) {
      return res.status(400).json({
        error: "Stream ID is required",
      });
    }

    const stream = await getActiveStream(streamId);

    if (!stream) {
      return res.status(404).json({
        error: "Live session not found or has ended",
      });
    }

    if (stream.user_id !== user.id) {
      return res.status(403).json({
        error: "Only the host can view approved speakers",
      });
    }

    const { data, error } = await supabaseAdmin
      .from("live_speaker_requests")
      .select(
        "id, stream_id, user_id, status, host_muted, created_at"
      )
      .eq("stream_id", stream.id)
      .eq("status", "approved")
      .order("created_at", { ascending: true });

    if (error) throw error;

    let participants = [];

    try {
      participants = await roomService.listParticipants(
        `nasara-${stream.id}`
      );
    } catch (roomError) {
      console.warn(
        "COULD NOT LOAD LIVEKIT PARTICIPANTS:",
        roomError.message
      );
    }

    const participantMap = new Map(
      participants.map((participant) => [
        participant.identity,
        participant,
      ])
    );

    const speakers = (data || []).map((request) => {
      const participant = participantMap.get(request.user_id);

      return {
        ...request,
        participant_name: participant?.name || null,
        is_connected: !!participant,
      };
    });

    return res.status(200).json({
      speakers,
    });

  } catch (error) {
    console.error("GET APPROVED SPEAKERS ERROR:", error);

    return res.status(500).json({
      error: "Unable to load approved speakers",
    });
  }
});

// ==================================================
// HOST: APPROVE SPEAKER
// POST /speaker/approve
// ==================================================

app.post("/speaker/approve", async (req, res) => {
  try {
    const user = await authenticateUser(req, res);
    if (!user) return;

    const { requestId } = req.body;

    if (!requestId) {
      return res.status(400).json({
        error: "Request ID is required",
      });
    }

    const result = await getHostSpeakerRequest(requestId, user);

    if (result.error) {
      return res.status(403).json({
        error: result.error,
      });
    }

    if (result.request.status !== "pending") {
      return res.status(409).json({
        error: "This request is no longer pending",
      });
    }

    const { data, error } = await supabaseAdmin
      .from("live_speaker_requests")
      .update({
        status: "approved",
        host_muted: false,
        host_muted_track_sids: [],
        updated_at: new Date().toISOString(),
      })
      .eq("id", requestId)
      .eq("status", "pending")
      .select("id, stream_id, user_id, status, host_muted")
      .maybeSingle();

    if (error) throw error;

    if (!data) {
      return res.status(409).json({
        error: "This request has already been handled",
      });
    }

    return res.status(200).json({
      message: "Speaker approved",
      request: data,
    });

  } catch (error) {
    console.error("APPROVE SPEAKER ERROR:", error);

    return res.status(500).json({
      error: "Unable to approve speaker",
    });
  }
});

// ==================================================
// HOST: REJECT SPEAKER REQUEST
// POST /speaker/reject
// ==================================================

app.post("/speaker/reject", async (req, res) => {
  try {
    const user = await authenticateUser(req, res);
    if (!user) return;

    const { requestId } = req.body;

    if (!requestId) {
      return res.status(400).json({
        error: "Request ID is required",
      });
    }

    const result = await getHostSpeakerRequest(requestId, user);

    if (result.error) {
      return res.status(403).json({
        error: result.error,
      });
    }

    if (result.request.status !== "pending") {
      return res.status(409).json({
        error: "This request is no longer pending",
      });
    }

    const { data, error } = await supabaseAdmin
      .from("live_speaker_requests")
      .update({
        status: "rejected",
        host_muted: false,
        host_muted_track_sids: [],
        updated_at: new Date().toISOString(),
      })
      .eq("id", requestId)
      .eq("status", "pending")
      .select("id, status")
      .maybeSingle();

    if (error) throw error;

    if (!data) {
      return res.status(409).json({
        error: "This request has already been handled",
      });
    }

    return res.status(200).json({
      message: "Speaker request rejected",
      request: data,
    });

  } catch (error) {
    console.error("REJECT SPEAKER ERROR:", error);

    return res.status(500).json({
      error: "Unable to reject speaker",
    });
  }
});

// ==================================================
// HOST: MUTE OR UNMUTE APPROVED SPEAKER
//
// POST /speaker/mute
//
// Body:
// {
//   "requestId": "...",
//   "muted": true
// }
//
// muted = true  -> mute
// muted = false -> unmute
// ==================================================

app.post("/speaker/mute", async (req, res) => {
  try {
    const user = await authenticateUser(req, res);
    if (!user) return;

    const { requestId, muted } = req.body;

    if (!requestId) {
      return res.status(400).json({
        error: "Request ID is required",
      });
    }

    if (typeof muted !== "boolean") {
      return res.status(400).json({
        error: "Muted must be true or false",
      });
    }

    const result = await getHostSpeakerRequest(requestId, user);

    if (result.error) {
      return res.status(403).json({
        error: result.error,
      });
    }

    const request = result.request;
    const stream = result.stream;

    if (request.status !== "approved") {
      return res.status(409).json({
        error: "This user is not an approved speaker",
      });
    }

    const previousMuted = request.host_muted === true;

    if (previousMuted === muted) {
      return res.status(200).json({
        message: muted
          ? "Speaker is already muted"
          : "Speaker is already unmuted",
        muted,
        connected: false,
      });
    }

    const roomName = `nasara-${stream.id}`;

    let participants = [];

    try {
      participants = await roomService.listParticipants(roomName);
    } catch (roomError) {
      console.warn(
        "LIVEKIT ROOM NOT AVAILABLE FOR SPEAKER CONTROL:",
        roomError.message
      );
    }

    const participant = participants.find(
      (item) => item.identity === request.user_id
    );

    let mutedTrackSids =
      request.host_muted_track_sids || [];

    let restoredTrackCount = 0;

    if (participant) {
      const previousPermission = participant.permission || {
        canPublish: true,
        canSubscribe: true,
        canPublishData: true,
      };

      const audioTracks = (participant.tracks || []).filter(
        (track) =>
          track.type === LIVEKIT_AUDIO_TRACK_TYPE
      );

      try {
        if (muted) {
          // Remember the audio tracks that were not
          // already muted before the host action.
          mutedTrackSids = audioTracks
            .filter((track) => track.muted !== true)
            .map((track) => track.sid);

          // First mute the existing audio tracks.
          // This mutes the speaker for everybody.
          for (const track of audioTracks) {
            if (track.muted !== true) {
              await roomService.mutePublishedTrack(
                roomName,
                request.user_id,
                track.sid,
                true
              );
            }
          }

          // Then prevent new microphone/audio publications
          // while the speaker is host-muted.
          await roomService.updateParticipant(
            roomName,
            request.user_id,
            {
              permission: {
                ...previousPermission,
                canPublish: true,
                canSubscribe: true,
                canPublishData:
                  previousPermission.canPublishData !== false,
                canPublishSources: SPEAKER_MUTED_SOURCES,
              },
            }
          );

        } else {
          // IMPORTANT:
          // Restore microphone permission FIRST.
          // Previously this happened after track unmuting.
          await roomService.updateParticipant(
            roomName,
            request.user_id,
            {
              permission: {
                ...previousPermission,
                canPublish: true,
                canSubscribe: true,
                canPublishData:
                  previousPermission.canPublishData !== false,
                canPublishSources: SPEAKER_UNMUTED_SOURCES,
              },
            }
          );

          // Now unmute the same audio tracks that the
          // host muted. Do not disconnect the speaker.
          const tracksToUnmute = audioTracks.filter(
            (track) =>
              track.muted === true &&
              mutedTrackSids.includes(track.sid)
          );

          for (const track of tracksToUnmute) {
            await roomService.mutePublishedTrack(
              roomName,
              request.user_id,
              track.sid,
              false
            );

            restoredTrackCount += 1;
          }

          mutedTrackSids = [];
        }

      } catch (liveKitError) {
        console.error(
          "LIVEKIT SPEAKER MUTE / UNMUTE ERROR:",
          liveKitError
        );

        // Restore the permissions that existed before
        // this request if any LiveKit operation fails.
        try {
          await roomService.updateParticipant(
            roomName,
            request.user_id,
            {
              permission: previousPermission,
            }
          );
        } catch (restoreError) {
          console.error(
            "SPEAKER PERMISSION RESTORE ERROR:",
            restoreError
          );
        }

        throw liveKitError;
      }
    }

    // Save the mute state only after LiveKit operations
    // have completed successfully.
    const { data: updatedRequest, error: updateError } =
      await supabaseAdmin
        .from("live_speaker_requests")
        .update({
          host_muted: muted,
          host_muted_track_sids: muted
            ? mutedTrackSids
            : [],
          updated_at: new Date().toISOString(),
        })
        .eq("id", requestId)
        .eq("status", "approved")
        .select("id, host_muted")
        .maybeSingle();

    if (updateError) throw updateError;

    if (!updatedRequest) {
      throw new Error(
        "Could not save the speaker mute state"
      );
    }

    return res.status(200).json({
      message: muted
        ? "Speaker muted"
        : "Speaker unmuted",
      muted,
      connected: !!participant,
      restoredTrackCount,
    });

  } catch (error) {
    console.error(
      "MUTE / UNMUTE SPEAKER ERROR:",
      error
    );

    return res.status(500).json({
      error:
        error.message ||
        "Unable to change speaker mute state",
    });
  }
});

// ==================================================
// HOST: REMOVE APPROVED SPEAKER
// POST /speaker/remove
// ==================================================

app.post("/speaker/remove", async (req, res) => {
  try {
    const user = await authenticateUser(req, res);
    if (!user) return;

    const { requestId } = req.body;

    if (!requestId) {
      return res.status(400).json({
        error: "Request ID is required",
      });
    }

    const result = await getHostSpeakerRequest(requestId, user);

    if (result.error) {
      return res.status(403).json({
        error: result.error,
      });
    }

    if (result.request.status !== "approved") {
      return res.status(409).json({
        error: "This user is not an approved speaker",
      });
    }

    // Revoke speaker permission in Supabase first.
    const { error } = await supabaseAdmin
      .from("live_speaker_requests")
      .update({
        status: "rejected",
        host_muted: false,
        host_muted_track_sids: [],
        updated_at: new Date().toISOString(),
      })
      .eq("id", requestId)
      .eq("status", "approved");

    if (error) throw error;

    // Disconnect the speaker and revoke their current token.
    let disconnected = true;

    try {
      await roomService.removeParticipant(
        `nasara-${result.stream.id}`,
        result.request.user_id,
        {
          revokeTokenTs: BigInt(
            Math.floor(Date.now() / 1000)
          ),
        }
      );

    } catch (removeError) {
      disconnected = false;

      console.error(
        "LIVEKIT SPEAKER DISCONNECT ERROR:",
        removeError
      );
    }

    return res.status(200).json({
      message: "Speaker permission revoked",
      disconnected,
    });

  } catch (error) {
    console.error("REMOVE SPEAKER ERROR:", error);

    return res.status(500).json({
      error: "Unable to remove speaker",
    });
  }
});

// ==================================================
// START SERVER
// ==================================================

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log(
    `Nasara LiveKit server running on port ${PORT}`
  );
});
