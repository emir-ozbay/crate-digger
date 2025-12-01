// app/api/auth/spotify/login/route.ts
import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const redirectUri = process.env.SPOTIFY_REDIRECT_URI;
  const scopes = process.env.SPOTIFY_SCOPES;

  if (!clientId || !redirectUri || !scopes) {
    console.error("Missing Spotify env vars", {
      hasClientId: !!clientId,
      hasRedirect: !!redirectUri,
      hasScopes: !!scopes,
    });
    return NextResponse.json(
      { error: "Spotify configuration missing" },
      { status: 500 }
    );
  }

  const state = "debug-" + crypto.randomUUID();

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: scopes,
    state,
  });

  const authUrl = `https://accounts.spotify.com/authorize?${params.toString()}`;

  console.log("DEBUG authUrl:", authUrl);

  // TEMP: return JSON instead of redirect so we can inspect
  return NextResponse.json({
    authUrl,
    redirectUri,
    scopes,
  });
}
