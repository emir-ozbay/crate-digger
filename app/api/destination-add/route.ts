// app/api/destination-add/route.ts
import { NextRequest, NextResponse } from "next/server";
import SpotifyWebApi from "spotify-web-api-node";

export async function POST(req: NextRequest) {
  try {
    // ✅ use cookies from the request instead of `cookies()` helper
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

    // 🔍 Check for duplicates (first 100 tracks)
    try {
      const existing = await spotifyApi.getPlaylistTracks(playlistId, {
        limit: 100,
        offset: 0,
        fields: "items(track(uri))",
      });

      const alreadyThere =
        existing.body.items?.some(
          (item: any) => item.track && item.track.uri === trackUri
        ) ?? false;

      if (alreadyThere) {
        return NextResponse.json(
          { added: false, reason: "duplicate", playlistId },
          { status: 200 }
        );
      }
    } catch (dupeErr: any) {
      console.error(
        "Error checking existing tracks before add:",
        dupeErr?.body || dupeErr
      );
      // We can still *try* to add, but log it
    }

    // ➕ Add the track
    await spotifyApi.addTracksToPlaylist(playlistId, [trackUri]);

    return NextResponse.json(
      { added: true, playlistId },
      { status: 200 }
    );
  } catch (err: any) {
    console.error("Error adding track to playlist:", err?.body || err);
    return NextResponse.json(
      {
        error: "Spotify API error while adding track",
        details: err?.body || String(err),
      },
      { status: 500 }
    );
  }
}
