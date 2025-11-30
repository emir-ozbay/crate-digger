import { NextRequest, NextResponse } from "next/server";
import SpotifyWebApi from "spotify-web-api-node";

function getSpotifyClient(req: NextRequest) {
  // We assume your auth flow stores the access token in this cookie
  const accessToken = req.cookies.get("spotify_access_token")?.value;

  if (!accessToken) {
    return null;
  }

  // We only need an API instance with an access token.
  const spotifyApi = new SpotifyWebApi();
  spotifyApi.setAccessToken(accessToken);

  return spotifyApi;
}

export async function GET(req: NextRequest) {
  const spotifyApi = getSpotifyClient(req);

  if (!spotifyApi) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // Get current user info (to know your user id)
    const meRes = await spotifyApi.getMe();
    const currentUserId = meRes.body.id;

    // Get playlists visible to the user
    const playlistsRes = await spotifyApi.getUserPlaylists({ limit: 50 });
    const body = playlistsRes.body;

    const items = (body.items ?? []).map((pl: any) => ({
      id: pl.id,
      name: pl.name,
      images: pl.images,
      tracks: pl.tracks,
      ownerId: pl.owner?.id ?? null,
      ownerName: pl.owner?.display_name ?? null,
      isOwned: pl.owner?.id === currentUserId,
    }));

    return NextResponse.json({ items, currentUserId });
  } catch (err: any) {
    console.error("Error fetching playlists:", err);

    // If the token is expired or invalid, treat as unauthorized
    const status =
      err?.statusCode && typeof err.statusCode === "number"
        ? err.statusCode
        : 500;

    if (status === 401) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    return NextResponse.json(
      { error: "Failed to fetch playlists" },
      { status: 500 }
    );
  }
}
