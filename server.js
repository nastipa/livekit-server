require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { AccessToken } = require("livekit-server-sdk");

const app = express();

app.use(cors());
app.use(express.json());

app.get("/token", async (req, res) => {
  try {
    const { room, username } = req.query;

    if (!room || !username) {
      return res.status(400).json({
        error: "room and username required",
      });
    }

    const token = new AccessToken(
      process.env.LIVEKIT_API_KEY,
      process.env.LIVEKIT_API_SECRET,
      {
        identity: username,
      }
    );

    token.addGrant({
      roomJoin: true,
      room,
      canPublish: true,
      canSubscribe: true,
    });

    const jwt = await token.toJwt();

    return res.json({
      token: jwt,
      url: process.env.LIVEKIT_URL,
    });
  } catch (error) {
    console.log("TOKEN ERROR:", error);

    return res.status(500).json({
      error: "failed to create token",
    });
  }
});

app.get("/", (_, res) => {
  res.send("LiveKit token server running");
});

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log(`LiveKit server running on port ${PORT}`);
});