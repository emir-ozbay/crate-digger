// app/api/remove-from-playlist/route.ts
import { NextRequest, NextResponse } from "next/server";
import SpotifyWebApi from "spotify-web-api-node";

export async function POST(req: NextRequest) {
  try {
    const accessToken = req.cookies.get("spotify_access_token")?.value || null;

    if (!accessToken) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    const spotifyApi = new SpotifyWebApi({
      clientId: process.env.SPOTIFY_CLIENT_ID,
      clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
      redirectUri: process.env.SPOTIFY_REDIRECT_URI,
    });

    spotifyApi.setAccessToken(accessToken);

    const { playlistId, trackUri } = await req.json();

    if (!playlistId || !trackUri) {
      return NextResponse.json(
        { error: "playlistId and trackUri are required" },
        { status: 400 }
      );
    }

    // Remove a single track from the playlist
    await spotifyApi.removeTracksFromPlaylist(playlistId, [{ uri: trackUri }]);

    return NextResponse.json(
      { removed: true, playlistId, trackUri },
      { status: 200 }
    );
  } catch (err: any) {
    console.error("Error removing track from playlist:", err?.body || err);
    return NextResponse.json(
      {
        error: "Spotify API error while removing track",
        details: err?.body || String(err),
      },
      { status: 500 }
    );
  }
}
