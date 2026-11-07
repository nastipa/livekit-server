// ==================================================
// 📦 IMPORTS
// ==================================================

require("dotenv").config();

const express = require("express");
const cors = require("cors");

const { createClient } = require("@supabase/supabase-js");
const { AccessToken } = require("livekit-server-sdk");

// ==================================================
// ⚙️ SERVER CONFIGURATION
// ==================================================

const app = express();

app.use(cors({
  origin: (origin, callback) => {
    // Allow mobile apps and server-to-server requests.
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
// 🔐 ENVIRONMENT VALIDATION
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
// 🗄️ SUPABASE ADMIN CLIENT
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
// ❤️ HEALTH CHECK
// ==================================================

app.get("/", (req, res) => {
  res.status(200).send("Nasara LiveKit server running");
});

// ==================================================
// 🎥 CREATE SECURE LIVEKIT TOKEN
// ==================================================

app.post("/token", async (req, res) => {
  try {
    // ----------------------------------------------
    // 1. CHECK REQUIRED CONFIGURATION
    // ----------------------------------------------

    if (
      !process.env.LIVEKIT_API_KEY ||
      !process.env.LIVEKIT_API_SECRET ||
      !process.env.LIVEKIT_URL
    ) {
      return res.status(500).json({
        error: "LiveKit server configuration is incomplete",
      });
    }

    // ----------------------------------------------
    // 2. VERIFY SUPABASE ACCESS TOKEN
    // ----------------------------------------------

    const authorization = req.headers.authorization || "";

    if (!authorization.startsWith("Bearer ")) {
      return res.status(401).json({
        error: "Authentication required",
      });
    }

    const accessToken = authorization.substring(7);

    const {
      data: { user },
      error: authError,
    } = await supabaseAdmin.auth.getUser(accessToken);

    if (authError || !user) {
      return res.status(401).json({
        error: "Invalid or expired login session",
      });
    }

    // ----------------------------------------------
    // 3. VALIDATE LIVE SESSION
    // ----------------------------------------------

    const { streamId } = req.body;

    if (!streamId) {
      return res.status(400).json({
        error: "Stream ID is required",
      });
    }

    const {
      data: stream,
      error: streamError,
    } = await supabaseAdmin
      .from("live_streams")
      .select("id, user_id, title, status, is_active")
      .eq("id", streamId)
      .eq("status", "live")
      .eq("is_active", true)
      .maybeSingle();

    if (streamError) {
      console.error("STREAM LOOKUP ERROR:", streamError);

      return res.status(500).json({
        error: "Unable to verify live session",
      });
    }

    if (!stream) {
      return res.status(404).json({
        error: "Live session not found or has ended",
      });
    }

    // ----------------------------------------------
    // 4. DETERMINE USER PERMISSIONS
    // ----------------------------------------------

    const isHost = stream.user_id === user.id;

    // Only the actual stream owner can publish.
    // All authenticated users can watch.

    const canPublish = isHost;

    // ----------------------------------------------
    // 5. CREATE LIVEKIT ROOM NAME
    // ----------------------------------------------

    const roomName = `nasara-${stream.id}`;

    // ----------------------------------------------
    // 6. GENERATE LIVEKIT ACCESS TOKEN
    // ----------------------------------------------

    const token = new AccessToken(
      process.env.LIVEKIT_API_KEY,
      process.env.LIVEKIT_API_SECRET,
      {
        identity: user.id,
        ttl: "10m",
      }
    );

    token.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish,
      canSubscribe: true,
    });

    const jwt = await token.toJwt();

    // ----------------------------------------------
    // 7. RETURN TOKEN
    // ----------------------------------------------

    return res.status(200).json({
      token: jwt,
      url: process.env.LIVEKIT_URL,
      roomName,
      role: isHost ? "host" : "viewer",
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
// 🚀 START SERVER
// ==================================================

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log(`Nasara LiveKit server running on port ${PORT}`);
});
