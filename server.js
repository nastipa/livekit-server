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
// HEALTH CHECK
// ==================================================

app.get("/", (req, res) => {
  res.status(200).send("Nasara LiveKit server running");
});

// ==================================================
// CREATE LIVEKIT TOKEN
// HOST = PUBLISH
// APPROVED SPEAKER = PUBLISH
// NORMAL VIEWER = WATCH ONLY
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

    if (!isHost) {
      const { data: speakerRequest, error } = await supabaseAdmin
        .from("live_speaker_requests")
        .select("id, status")
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

    token.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish,
      canSubscribe: true,
    });

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
// HOST: APPROVE OR REJECT A SPEAKER REQUEST
// ==================================================

async function getHostSpeakerRequest(requestId, user) {
  const { data: request, error } = await supabaseAdmin
    .from("live_speaker_requests")
    .select("id, stream_id, user_id, status")
    .eq("id", requestId)
    .maybeSingle();

  if (error) throw error;
  if (!request) return { error: "Speaker request not found" };

  const stream = await getActiveStream(request.stream_id);

  if (!stream) {
    return { error: "Live session not found or has ended" };
  }

  if (stream.user_id !== user.id) {
    return { error: "Only the host can manage speaker requests" };
  }

  return { request, stream };
}

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
        updated_at: new Date().toISOString(),
      })
      .eq("id", requestId)
      .eq("status", "pending")
      .select("id, stream_id, user_id, status")
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
      error: "Unable to reject speaker request",
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

    // Revoke permission in Supabase first.
    const { error } = await supabaseAdmin
      .from("live_speaker_requests")
      .update({
        status: "rejected",
        updated_at: new Date().toISOString(),
      })
      .eq("id", requestId)
      .eq("status", "approved");

    if (error) throw error;

    // Disconnect the speaker from the LiveKit room.
    let disconnected = true;

    try {
      await roomService.removeParticipant(
        `nasara-${result.stream.id}`,
        result.request.user_id
      );
    } catch (removeError) {
      disconnected = false;
      console.error("LIVEKIT SPEAKER DISCONNECT ERROR:", removeError);
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
  console.log(`Nasara LiveKit server running on port ${PORT}`);
});
