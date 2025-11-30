// app/api/auth/spotify/login/route.ts
import { NextRequest, NextResponse } from "next/server";

const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID!;
const SPOTIFY_REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI!; // http://127.0.0.1:3000/api/auth/spotify/callback
const SPOTIFY_SCOPES = process.env.SPOTIFY_SCOPES!; // playlist-read-private ...


export async function GET(req: NextRequest) {
  console.log("LOGIN redirect URI:", SPOTIFY_REDIRECT_URI);

  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_REDIRECT_URI || !SPOTIFY_SCOPES) {
    console.error("Missing Spotify env vars");
    return NextResponse.json(
      { error: "Spotify configuration missing" },
      { status: 500 }
    );
  }

  const state = crypto.randomUUID(); // you can store/validate this if you want CSRF protection

  const params = new URLSearchParams({
    client_id: SPOTIFY_CLIENT_ID,
    response_type: "code",
    redirect_uri: SPOTIFY_REDIRECT_URI, // 🔴 IMPORTANT: uses 127.0.0.1, not localhost
    scope: SPOTIFY_SCOPES,
    state,
  });

  const authUrl = `https://accounts.spotify.com/authorize?${params.toString()}`;

  return NextResponse.redirect(authUrl);
}
