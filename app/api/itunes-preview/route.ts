// app/api/itunes-preview/route.ts
import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const trackName = url.searchParams.get("trackName") || "";
  const artistName = url.searchParams.get("artistName") || "";

  const query = `${trackName} ${artistName}`.trim();
  if (!query) {
    return NextResponse.json({ previewUrl: null });
  }

  const params = new URLSearchParams({
    term: query,
    media: "music",
    entity: "song",
    limit: "1",
  });

  const res = await fetch(`https://itunes.apple.com/search?${params.toString()}`);

  if (!res.ok) {
    console.warn("iTunes search error status:", res.status);
    return NextResponse.json({ previewUrl: null });
  }

  const data = await res.json();

  if (!data.results || data.results.length === 0) {
    return NextResponse.json({ previewUrl: null });
  }

  const first = data.results[0];
  const previewUrl = first.previewUrl ?? null;

  return NextResponse.json({ previewUrl });
}
