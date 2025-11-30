// app/api/auth/spotify/login/route.ts
import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  // Read env vars at runtime so Vercel picks up latest values
  const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
  const SPOTIFY_REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI; // dev: 127.0.0.1..., prod: vercel URL
  const SPOTIFY_SCOPES = process.env.SPOTIFY_SCOPES;

  console.log("LOGIN redirect URI:", SPOTIFY_REDIRECT_URI);

  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_REDIRECT_URI || !SPOTIFY_SCOPES) {
    console.error("Missing Spotify env vars", {
      hasClientId: !!SPOTIFY_CLIENT_ID,
      hasRedirect: !!SPOTIFY_REDIRECT_URI,
      hasScopes: !!SPOTIFY_SCOPES,
    });
    return NextResponse.json(
      { error: "Spotify configuration missing" },
      { status: 500 }
    );
  }

  const state = crypto.randomUUID(); // you can store/validate this if you want CSRF protection

  const params = new URLSearchParams({
    client_id: SPOTIFY_CLIENT_ID,
    response_type: "code",
    redirect_uri: SPOTIFY_REDIRECT_URI,
    scope: SPOTIFY_SCOPES,
    state,
  });

  const authUrl = `https://accounts.spotify.com/authorize?${params.toString()}`;

  return NextResponse.redirect(authUrl);
}
