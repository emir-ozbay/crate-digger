// app/api/auth/spotify/callback/route.ts
import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  const redirectUri = process.env.SPOTIFY_REDIRECT_URI;

  const url = req.nextUrl;
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  const hostHeader = req.headers.get("host") || "";
  const isLocal =
    hostHeader.startsWith("127.0.0.1") || hostHeader.startsWith("localhost");
  const scheme = isLocal ? "http" : "https";

  const originFromHost = hostHeader
    ? `${scheme}://${hostHeader}`
    : process.env.NEXT_PUBLIC_APP_URL || url.origin;

  console.log("CALLBACK originFromHost:", originFromHost);
  console.log("CALLBACK redirectUri (env):", redirectUri);

  if (error) {
    console.error("Spotify auth error:", error);
    return NextResponse.redirect(
      `${originFromHost}/?spotify_error=${encodeURIComponent(error)}`
    );
  }

  if (!code) {
    console.error("Spotify callback missing code");
    return NextResponse.redirect(
      `${originFromHost}/?spotify_error=missing_code`
    );
  }

  if (!clientId || !clientSecret || !redirectUri) {
    console.error("Spotify env vars missing", {
      hasClientId: !!clientId,
      hasSecret: !!clientSecret,
      hasRedirect: !!redirectUri,
    });
    return NextResponse.redirect(
      `${originFromHost}/?spotify_error=server_config_missing`
    );
  }

  try {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    });

    const basicAuth = Buffer.from(
      `${clientId}:${clientSecret}`
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

    const redirectUrl = new URL("/", originFromHost);
    console.log("Redirecting back to:", redirectUrl.toString());

    const res = NextResponse.redirect(redirectUrl);

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
    return NextResponse.redirect(
      `${originFromHost}/?spotify_error=internal_error`
    );
  }
}
