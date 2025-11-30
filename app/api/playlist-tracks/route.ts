// app/api/playlist-tracks/route.ts
import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  const accessToken = req.cookies.get("spotify_access_token")?.value;

  if (!accessToken) {
    return new NextResponse("Not authenticated", { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const playlistId = searchParams.get("playlistId");

  if (!playlistId) {
    return new NextResponse("Missing playlistId", { status: 400 });
  }

  const headers = {
    Authorization: `Bearer ${accessToken}`,
  };

  // 1) Fetch *all* playlist tracks via pagination
  let allItems: any[] = [];
  let baseData: any | null = null;

  let nextUrl: string | null = `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=100`;

  try {
    while (nextUrl) {
      const tracksRes = await fetch(nextUrl, { headers });

      if (!tracksRes.ok) {
        const text = await tracksRes.text();
        console.error("Spotify tracks error:", text);
        return new NextResponse("Failed to fetch tracks", { status: 500 });
      }

      const pageData = await tracksRes.json();

      // Save the first page's metadata as baseData
      if (!baseData) {
        baseData = pageData;
      }

      const items = pageData.items || [];
      allItems = allItems.concat(items);

      // Spotify gives a full URL in `next` (or null if no more pages)
      nextUrl = pageData.next;
    }
  } catch (err) {
    console.error("Error while paginating playlist tracks:", err);
    return new NextResponse("Failed to fetch tracks", { status: 500 });
  }

  // If for some reason we got no baseData, just fallback to a simple structure
  if (!baseData) {
    baseData = {
      href: null,
      items: [],
      limit: 100,
      next: null,
      offset: 0,
      previous: null,
      total: 0,
    };
  }

  // 2) Collect unique artist IDs from all tracks
  const artistIdSet = new Set<string>();

  for (const item of allItems) {
    const track = item.track;
    if (!track || !track.artists) continue;
    for (const artist of track.artists) {
      if (artist && artist.id) {
        artistIdSet.add(artist.id);
      }
    }
  }

  const artistIds = Array.from(artistIdSet);
  const artistGenresMap: Record<string, string[]> = {};

  // 3) Fetch artist info (and genres) in chunks of 50
  if (artistIds.length > 0) {
    try {
      for (let i = 0; i < artistIds.length; i += 50) {
        const chunk = artistIds.slice(i, i + 50);
        const resArtists = await fetch(
          `https://api.spotify.com/v1/artists?ids=${chunk.join(",")}`,
          { headers }
        );

        if (!resArtists.ok) {
          const text = await resArtists.text();
          console.error("Spotify artists error:", text);
          // If this fails, just return original data
          return NextResponse.json({
            ...baseData,
            items: allItems,
          });
        }

        const dataArtists = await resArtists.json();
        const artists = dataArtists.artists || [];

        for (const artist of artists) {
          if (artist && artist.id) {
            artistGenresMap[artist.id] = artist.genres || [];
          }
        }
      }
    } catch (err) {
      console.error("Error fetching artist genres:", err);
      // If something goes wrong, return tracks without genres rather than failing
      return NextResponse.json({
        ...baseData,
        items: allItems,
      });
    }
  }

  // 4) Attach aggregated artist genres to each playlist item
  const itemsWithGenres = allItems.map((item: any) => {
    const track = item.track;
    if (!track || !track.artists) return item;

    const genresSet = new Set<string>();

    for (const artist of track.artists) {
      const g = artistGenresMap[artist.id] || [];
      for (const genre of g) {
        genresSet.add(genre);
      }
    }

    return {
      ...item,
      artist_genres: Array.from(genresSet),
    };
  });

  // 5) Return the same shape as Spotify's playlist-tracks, but with all items + genres
  const result = {
    ...baseData,
    items: itemsWithGenres,
  };

  return NextResponse.json(result);
}
