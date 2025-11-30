// app/api/create-playlist/route.ts
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

    const { name } = await req.json();

    if (!name || typeof name !== "string" || !name.trim()) {
      return NextResponse.json(
        { error: "Playlist name is required" },
        { status: 400 }
      );
    }

    const trimmedName = name.trim();

    // Optional sanity check – will also surface scope / token issues clearly
    try {
      const me = await spotifyApi.getMe();
      console.log(
        "Creating playlist for user",
        me.body.id,
        "name:",
        trimmedName
      );
    } catch (meErr: any) {
      console.error("getMe() failed before createPlaylist:", meErr?.body || meErr);
      return NextResponse.json(
        {
          error: "Spotify getMe failed",
          details: meErr?.body || String(meErr),
        },
        { status: 500 }
      );
    }

    const created = await spotifyApi.createPlaylist(trimmedName, {
      public: false,
      description: "Created with Crate Digger",
    });

    const body: any = created.body;

    const playlist = {
      id: body.id,
      name: body.name,
      images: body.images ?? [],
      tracks: { total: body.tracks?.total ?? 0 },
      ownerId: body.owner?.id ?? null,
      ownerName: body.owner?.display_name ?? null,
    };

    return NextResponse.json(playlist, { status: 200 });
  } catch (err: any) {
    console.error("Error creating playlist:", err?.body || err);
    return NextResponse.json(
      {
        error: "Spotify API error while creating playlist",
        details: err?.body || String(err),
      },
      { status: 500 }
    );
  }
}
