const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Page principale
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Vérification du serveur
app.get("/health", (req, res) => {
  res.json({
    status: "online",
    game: "TIRVEXA",
    version: "V5",
    mode: "Solo"
  });
});

// Informations du jeu
app.get("/api/config", (req, res) => {
  res.json({
    game: "TIRVEXA",
    version: "V5",
    season: "Saison 1 — Premier Tir",
    modes: [
      "Solo",
      "Entraînement"
    ],
    multiplayer: false,
    owner: "DJABEA ANGEL",
    creator: "DJABEA ANGEL"
  });
});

// Résultat d'une partie
app.post("/api/game-result", (req, res) => {
  const { score, mode } = req.body;

  if (typeof score !== "number") {
    return res.status(400).json({
      error: "Score invalide"
    });
  }

  res.json({
    success: true,
    score,
    mode: mode || "Solo",
    message: "Résultat enregistré"
  });
});

// Démarrage du serveur
app.listen(PORT, "0.0.0.0", () => {
  console.log(`TIRVEXA V5 démarré sur le port ${PORT}`);
});
