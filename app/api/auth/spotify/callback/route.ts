import { NextRequest, NextResponse } from "next/server";

const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID!;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET!;
const SPOTIFY_REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI!; // http://127.0.0.1:3000/api/auth/spotify/callback

export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  // For debugging:
  const hostHeader = req.headers.get("host") || "";
  console.log("CALLBACK host header:", hostHeader);
  console.log("CALLBACK nextUrl.origin:", url.origin);

  if (error) {
    console.error("Spotify auth error:", error);

    const originFromHost = hostHeader
      ? `http://${hostHeader}`
      : url.origin;

    return NextResponse.redirect(
      `${originFromHost}/?spotify_error=${encodeURIComponent(error)}`
    );
  }

  if (!code) {
    console.error("Spotify callback missing code");

    const originFromHost = hostHeader
      ? `http://${hostHeader}`
      : url.origin;

    return NextResponse.redirect(
      `${originFromHost}/?spotify_error=missing_code`
    );
  }

  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET || !SPOTIFY_REDIRECT_URI) {
    console.error("Spotify env vars missing");

    const originFromHost = hostHeader
      ? `http://${hostHeader}`
      : url.origin;

    return NextResponse.redirect(
      `${originFromHost}/?spotify_error=server_config_missing`
    );
  }

  try {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: SPOTIFY_REDIRECT_URI,
    });

    const basicAuth = Buffer.from(
      `${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`
    ).toString("base64");

    const tokenRes = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${basicAuth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });

    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      console.error("Spotify token exchange failed:", tokenRes.status, text);

      const originFromHost = hostHeader
        ? `http://${hostHeader}`
        : url.origin;

      return NextResponse.redirect(
        `${originFromHost}/?spotify_error=token_exchange_failed`
      );
    }

    const tokenData = (await tokenRes.json()) as {
      access_token: string;
      token_type: string;
      scope: string;
      expires_in: number; // seconds
      refresh_token?: string;
    };

    const accessToken = tokenData.access_token;
    const refreshToken = tokenData.refresh_token;
    const expiresIn = tokenData.expires_in || 3600;

    // ⚠️ IMPORTANT: build origin from Host header (127.0.0.1:3000),
    // not from url.origin (which Next dev treats as localhost:3000)
    const originFromHost = hostHeader
      ? `http://${hostHeader}`
      : url.origin;

    const redirectUrl = new URL("/", originFromHost);
    console.log("Redirecting back to:", redirectUrl.toString());

    const res = NextResponse.redirect(redirectUrl);

    // Access token cookie (host-only: 127.0.0.1 in your case)
    res.cookies.set("spotify_access_token", accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: expiresIn,
    });

    if (refreshToken) {
      res.cookies.set("spotify_refresh_token", refreshToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
        maxAge: 60 * 60 * 24 * 30,
      });
    }

    return res;
  } catch (err) {
    console.error("Spotify callback internal error:", err);

    const originFromHost = hostHeader
      ? `http://${hostHeader}`
      : url.origin;

    return NextResponse.redirect(
      `${originFromHost}/?spotify_error=internal_error`
    );
  }
}
