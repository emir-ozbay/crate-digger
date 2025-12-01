"use client";

import { useEffect, useRef, useState } from "react";
import { guess } from "web-audio-beat-detector";

type Playlist = {
  id: string;
  name: string;
  images?: { url: string }[];
  tracks?: { total: number };
  ownerId?: string | null;
  ownerName?: string | null;
};

type Track = {
  id: string;
  uri: string;
  name: string;
  artists: { name: string }[];
  duration_ms: number;
  genres: string[];
  preview_url: string | null;
  albumImageUrl: string | null;
  bpm?: number | null;
  bpmStatus?: "idle" | "loading" | "error";
};

type DestinationMode = "none" | "existing" | "new";

type DestinationSlot = {
  id: number; // 1..6
  mode: DestinationMode;
  playlistId: string | null;
  displayName: string;
  newName: string;
  sentTrackIds: string[];
};

const SLOT_COLORS: Record<number, string> = {
  1: "#22c55e",
  2: "#3b82f6",
  3: "#eab308",
  4: "#f97316",
  5: "#a855f7",
  6: "#ec4899",
};

function useIsMobile(breakpoint = 768) {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const update = () => setIsMobile(window.innerWidth < breakpoint);
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [breakpoint]);

  return isMobile;
}

export default function Home() {
  const isMobile = useIsMobile();

  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState(false);

  const [selectedPlaylistId, setSelectedPlaylistId] = useState<string | null>(
    null
  );
  const [selectedPlaylistName, setSelectedPlaylistName] =
    useState<string | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [loadingTracks, setLoadingTracks] = useState(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playingTrackId, setPlayingTrackId] = useState<string | null>(null);

  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null);

  const [previewOverrides, setPreviewOverrides] = useState<
    Record<string, string | null>
  >({});

  const lastItunesRequestTime = useRef<number | null>(null);
  const previewRequestIdRef = useRef(0);
  const followPlaybackRef = useRef(false);

  const audioContextRef = useRef<AudioContext | null>(null);

  const [destinations, setDestinations] = useState<DestinationSlot[]>(() =>
    Array.from({ length: 6 }, (_, i) => ({
      id: i + 1,
      mode: "none" as DestinationMode,
      playlistId: null,
      displayName: "",
      newName: "",
      sentTrackIds: [],
    }))
  );

  const [recentSend, setRecentSend] = useState<{
    slotId: number;
    trackId: string;
  } | null>(null);

  const [autoRemoveOnSend, setAutoRemoveOnSend] = useState(false);

  const rowRefs = useRef<Record<string, HTMLTableRowElement | null>>({});
  const tracksContainerRef = useRef<HTMLDivElement | null>(null);

  const [showPlaylists, setShowPlaylists] = useState(true);
  const [showDestinationsSheet, setShowDestinationsSheet] = useState(false);

  const focusTracks = () => {
    if (tracksContainerRef.current) {
      tracksContainerRef.current.focus();
    }
  };

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!audioContextRef.current) {
      const AC =
        (window as any).AudioContext || (window as any).webkitAudioContext;
      if (AC) {
        audioContextRef.current = new AC();
      } else {
        console.warn("Web Audio API not supported in this browser.");
      }
    }
  }, []);

  const detectBpmFromUrl = async (url: string): Promise<number | null> => {
    const audioContext = audioContextRef.current;
    if (!audioContext) return null;
    try {
      const res = await fetch(url);
      if (!res.ok) {
        console.error(
          "Failed to fetch audio for BPM detection. Status:",
          res.status
        );
        return null;
      }
      const arrayBuffer = await res.arrayBuffer();
      const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
      const { bpm } = await guess(audioBuffer);
      if (!bpm || !Number.isFinite(bpm)) return null;
      return bpm;
    } catch (err) {
      console.error("Error during BPM detection:", err);
      return null;
    }
  };

  useEffect(() => {
    const fetchPlaylists = async () => {
      try {
        const res = await fetch("/api/playlists");
        if (res.status === 401) {
          setAuthError(true);
          setLoading(false);
          return;
        }
        if (!res.ok) {
          console.error("Failed to load playlists");
          setLoading(false);
          return;
        }
        const data = await res.json();
        setPlaylists(data.items || []);
        setCurrentUserId(data.currentUserId || null);
        setLoading(false);
      } catch (err) {
        console.error(err);
        setLoading(false);
      }
    };
    fetchPlaylists();
  }, []);

  const handleLogin = () => {
    window.location.href = "/api/auth/spotify/login";
  };

  const handleLogout = async () => {
    try {
      await fetch("/api/auth/spotify/logout", { method: "POST" });
    } catch (err) {
      console.error("Logout error:", err);
    }
    window.location.href = "/";
  };

  const handleSelectPlaylist = async (playlist: Playlist) => {
    setSelectedPlaylistId(playlist.id);
    setSelectedPlaylistName(playlist.name);
    setTracks([]);
    setLoadingTracks(true);
    setPlayingTrackId(null);
    setSelectedTrackId(null);
    followPlaybackRef.current = false;

    if (isMobile) {
      setShowPlaylists(false);
    }

    if (audioRef.current) {
      previewRequestIdRef.current += 1;
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      audioRef.current.loop = false;
      audioRef.current.removeAttribute("src");
      audioRef.current.load();
    }

    try {
      const res = await fetch(
        `/api/playlist-tracks?playlistId=${encodeURIComponent(playlist.id)}`
      );
      if (!res.ok) {
        console.error("Failed to load tracks");
        setLoadingTracks(false);
        return;
      }
      const data = await res.json();
      const mappedTracks: Track[] = (data.items || [])
        .map((item: any) => {
          const track = item.track;
          if (!track) return null;
          const albumImageUrl =
            track.album?.images?.[0]?.url ?? null;
          return {
            id: track.id,
            uri: track.uri,
            name: track.name,
            artists: track.artists || [],
            duration_ms: track.duration_ms,
            genres: item.artist_genres || [],
            preview_url: track.preview_url ?? null,
            albumImageUrl,
            bpm: undefined,
            bpmStatus: "idle",
          } as Track;
        })
        .filter(Boolean) as Track[];
      setTracks(mappedTracks);
      setLoadingTracks(false);
    } catch (err) {
      console.error(err);
      setLoadingTracks(false);
    }
  };

  const formatGenres = (genres: string[]) => {
    if (!genres || genres.length === 0) return "–";
    const main = genres.slice(0, 3).join(" · ");
    if (genres.length > 3) return `${main} +${genres.length - 3}`;
    return main;
  };

  const getActiveTrack = (): Track | undefined => {
    const activeId = selectedTrackId || playingTrackId;
    if (!activeId) return undefined;
    return tracks.find((t) => t.id === activeId);
  };

  const handlePreviewClick = async (track: Track) => {
    if (playingTrackId === track.id) {
      previewRequestIdRef.current += 1;
      followPlaybackRef.current = false;
      if (audioRef.current) {
        audioRef.current.loop = false;
        audioRef.current.pause();
        audioRef.current.currentTime = 0;
        audioRef.current.removeAttribute("src");
        audioRef.current.load();
      }
      setPlayingTrackId(null);
      return;
    }

    if (playingTrackId && playingTrackId !== track.id && audioRef.current) {
      previewRequestIdRef.current += 1;
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      audioRef.current.loop = false;
      audioRef.current.removeAttribute("src");
      audioRef.current.load();
      setPlayingTrackId(null);
    }

    const myRequestId = ++previewRequestIdRef.current;
    setSelectedTrackId(track.id);

    let url: string | null =
      track.preview_url ||
      (typeof previewOverrides[track.id] === "string"
        ? (previewOverrides[track.id] as string)
        : null);

    if (!url && previewOverrides[track.id] === null) {
      followPlaybackRef.current = false;
      return;
    }

    if (!url) {
      const mainArtistName = track.artists?.[0]?.name ?? "";
      try {
        const now = Date.now();
        const minGap = 300;
        if (lastItunesRequestTime.current != null) {
          const diff = now - lastItunesRequestTime.current;
          if (diff < minGap) {
            await new Promise((resolve) =>
              setTimeout(resolve, minGap - diff)
            );
          }
        }
        lastItunesRequestTime.current = Date.now();

        const params = new URLSearchParams({
          trackName: track.name,
          artistName: mainArtistName,
        });
        const res = await fetch(
          `/api/itunes-preview?${params.toString()}`
        );
        if (res.ok) {
          const data = await res.json();
          url = data.previewUrl ?? null;
          setPreviewOverrides((prev) => ({
            ...prev,
            [track.id]: url,
          }));
        } else {
          url = null;
          setPreviewOverrides((prev) => ({
            ...prev,
            [track.id]: null,
          }));
        }
      } catch (err) {
        console.error("Error fetching iTunes preview:", err);
        url = null;
        setPreviewOverrides((prev) => ({
          ...prev,
          [track.id]: null,
        }));
      }
    }

    if (!url) {
      followPlaybackRef.current = false;
      return;
    }

    if (track.bpmStatus !== "loading" && track.bpm === undefined) {
      setTracks((prev) =>
        prev.map((t) =>
          t.id === track.id ? { ...t, bpmStatus: "loading" } : t
        )
      );
      detectBpmFromUrl(url).then((bpm) => {
        setTracks((prev) =>
          prev.map((t) =>
            t.id === track.id
              ? {
                  ...t,
                  bpm,
                  bpmStatus: bpm === null ? "error" : "idle",
                }
              : t
          )
        );
      });
    }

    if (previewRequestIdRef.current !== myRequestId) return;

    followPlaybackRef.current = true;

    if (!audioRef.current) {
      audioRef.current = new Audio();
    } else {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      audioRef.current.loop = false;
      audioRef.current.removeAttribute("src");
      audioRef.current.load();
    }

    audioRef.current.src = url;
    audioRef.current.currentTime = 0;
    audioRef.current.loop = true;

    if (previewRequestIdRef.current !== myRequestId) return;

    audioRef.current
      .play()
      .then(() => {
        if (previewRequestIdRef.current === myRequestId) {
          setPlayingTrackId(track.id);
        }
      })
      .catch((err: any) => {
        if (err?.name === "AbortError") return;
        console.error("Audio play error:", err);
        followPlaybackRef.current = false;
      });
  };

  const handleTrackNameClick = (track: Track) => {
    setSelectedTrackId(track.id);
    handlePreviewClick(track);
  };

  const handleDestinationSelectChange = (slotId: number, value: string) => {
    setDestinations((prev) =>
      prev.map((slot) => {
        if (slot.id !== slotId) return slot;
        if (value === "") {
          return {
            ...slot,
            mode: "none",
            playlistId: null,
            displayName: "",
            newName: "",
            sentTrackIds: [],
          };
        }
        if (value === "__new__") {
          return {
            ...slot,
            mode: "new",
            playlistId: null,
            displayName: slot.newName || "",
            sentTrackIds: [],
          };
        }
        const pl = playlists.find((p) => p.id === value);
        const playlistChanged = value !== slot.playlistId;
        return {
          ...slot,
          mode: "existing",
          playlistId: value,
          displayName: pl ? pl.name : value,
          newName: "",
          sentTrackIds: playlistChanged ? [] : slot.sentTrackIds,
        };
      })
    );
  };

  const handleDestinationNewNameChange = (slotId: number, name: string) => {
    setDestinations((prev) =>
      prev.map((slot) => {
        if (slot.id !== slotId) return slot;
        return {
          ...slot,
          mode: "new",
          playlistId: null,
          newName: name,
          displayName: name.trim(),
        };
      })
    );
  };

  const handleCreatePlaylistForSlot = async (slotId: number) => {
    const slot = destinations.find((s) => s.id === slotId);
    if (!slot) return;

    const name = (slot.newName || slot.displayName).trim();
    if (!name) {
      console.log(
        `Slot ${slotId}: please type a playlist name before creating.`
      );
      return;
    }

    try {
      const res = await fetch("/api/create-playlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        const errorText = await res.text();
        console.error(
          "Failed to create playlist for slot",
          slotId,
          "status:",
          res.status,
          "body:",
          errorText
        );
        return;
      }
      const data = await res.json();
      const newPlaylist: Playlist = {
        id: data.id,
        name: data.name,
        images: data.images || [],
        tracks: data.tracks || { total: 0 },
        ownerId: data.ownerId ?? null,
        ownerName: data.ownerName ?? null,
      };
      setPlaylists((prev) => {
        if (prev.some((p) => p.id === newPlaylist.id)) return prev;
        return [newPlaylist, ...prev];
      });
      setDestinations((prev) =>
        prev.map((s) =>
          s.id === slotId
            ? {
                ...s,
                mode: "existing",
                playlistId: newPlaylist.id,
                displayName: newPlaylist.name,
                newName: "",
              }
            : s
        )
      );
    } catch (err) {
      console.error("Error creating playlist for slot:", err);
    }
  };

  const handleSendToDestination = async (slotId: number, track: Track) => {
    const slot = destinations.find((s) => s.id === slotId);
    if (!slot) return;

    if (slot.mode !== "existing" || !slot.playlistId) {
      console.log(
        `Slot ${slotId} has no playlist yet. Select one or create it with the + button first.`
      );
      return;
    }

    if (selectedPlaylistId && slot.playlistId === selectedPlaylistId) {
      console.log(
        `Slot ${slotId}: source and destination playlist are the same. Skipping send.`
      );
      return;
    }

    if (slot.sentTrackIds.includes(track.id)) {
      console.log(
        `Track "${track.name}" is already processed for slot ${slotId} in this session. Skipping.`
      );
      return;
    }

    console.log(
      `Sending track "${track.name}" to slot ${slotId} (${slot.displayName ||
        slot.playlistId ||
        "unnamed"}).`
    );

    setRecentSend({ slotId, trackId: track.id });
    setTimeout(() => {
      setRecentSend((prev) =>
        prev && prev.slotId === slotId && prev.trackId === track.id
          ? null
          : prev
      );
    }, 200);

    try {
      const res = await fetch("/api/destination-add", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          playlistId: slot.playlistId,
          trackUri: track.uri,
        }),
      });
      if (!res.ok) {
        console.error("Failed to add track to playlist");
        return;
      }

      const data = await res.json();

      if (data.added) {
        console.log(
          `Track "${track.name}" added to playlist (id: ${data.playlistId}).`
        );
      } else if (data.reason === "duplicate") {
        console.log(
          `Track "${track.name}" is already in that playlist. Skipping duplicate.`
        );
      }

      if (autoRemoveOnSend) {
        const isSourceOwned =
          !!selectedPlaylistId &&
          !!currentUserId &&
          playlists.some(
            (pl) =>
              pl.id === selectedPlaylistId && pl.ownerId === currentUserId
          );

        const index = tracks.findIndex((t) => t.id === track.id);
        const nextTrack =
          index !== -1
            ? tracks[index + 1] || tracks[index - 1] || null
            : null;

        const handleLocalRemovalAndPlayback = () => {
          setTracks((prev) => prev.filter((t) => t.id !== track.id));
          if (nextTrack) {
            setSelectedTrackId(nextTrack.id);
            handlePreviewClick(nextTrack);
          } else {
            if (selectedTrackId === track.id) {
              setSelectedTrackId(null);
            }
            if (playingTrackId === track.id && audioRef.current) {
              previewRequestIdRef.current += 1;
              followPlaybackRef.current = false;
              audioRef.current.pause();
              audioRef.current.currentTime = 0;
              audioRef.current.loop = false;
              audioRef.current.removeAttribute("src");
              audioRef.current.load();
              setPlayingTrackId(null);
            }
          }
        };

        if (isSourceOwned) {
          try {
            const removeRes = await fetch("/api/remove-from-playlist", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                playlistId: selectedPlaylistId,
                trackUri: track.uri,
              }),
            });
            if (!removeRes.ok) {
              const errText = await removeRes.text();
              console.error(
                "Failed to remove track from source playlist:",
                removeRes.status,
                errText
              );
            } else {
              handleLocalRemovalAndPlayback();
            }
          } catch (err) {
            console.error("Error calling remove-from-playlist API:", err);
          }
        } else {
          handleLocalRemovalAndPlayback();
        }
      }

      setDestinations((prev) =>
        prev.map((s) =>
          s.id === slotId && !s.sentTrackIds.includes(track.id)
            ? { ...s, sentTrackIds: [...s.sentTrackIds, track.id] }
            : s
        )
      );
    } catch (err) {
      console.error("Error calling destination-add API:", err);
    }
  };

  useEffect(() => {
    const moveSelection = (direction: 1 | -1, shouldPlay: boolean) => {
      if (!tracks.length) return;
      const currentIndex = selectedTrackId
        ? tracks.findIndex((t) => t.id === selectedTrackId)
        : -1;
      if (currentIndex === -1) {
        if (direction === 1) {
          const first = tracks[0];
          if (!first) return;
          setSelectedTrackId(first.id);
        }
        return;
      }
      const newIndex = currentIndex + direction;
      if (newIndex < 0 || newIndex >= tracks.length) return;
      const newTrack = tracks[newIndex];
      if (!newTrack) return;
      setSelectedTrackId(newTrack.id);
      if (shouldPlay) {
        handlePreviewClick(newTrack);
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        const isFormField =
          tag === "INPUT" ||
          tag === "TEXTAREA" ||
          tag === "SELECT" ||
          target.isContentEditable;
        if (isFormField) return;
      }

      const hasModifier = e.altKey || e.ctrlKey || e.metaKey;
      const key = e.key;

      if (!hasModifier && ["1", "2", "3", "4", "5", "6"].includes(key)) {
        if (!selectedTrackId) return;
        const track = tracks.find((t) => t.id === selectedTrackId);
        if (!track) return;
        const slotId = parseInt(key, 10);
        handleSendToDestination(slotId, track);
        e.preventDefault();
        return;
      }

      if (key === "ArrowDown") {
        if (!tracks.length) return;
        const isSelected = !!selectedTrackId;
        if (!isSelected) {
          moveSelection(1, false);
        } else {
          moveSelection(1, followPlaybackRef.current);
        }
        e.preventDefault();
        return;
      }

      if (key === "ArrowUp") {
        if (!tracks.length || !selectedTrackId) return;
        moveSelection(-1, followPlaybackRef.current);
        e.preventDefault();
        return;
      }

      if (key === " " || key === "Spacebar") {
        if (!selectedTrackId && !playingTrackId) return;
        let track: Track | undefined;
        if (selectedTrackId) {
          track = tracks.find((t) => t.id === selectedTrackId);
        } else if (playingTrackId) {
          track = tracks.find((t) => t.id === playingTrackId);
        }
        if (track) {
          handlePreviewClick(track);
          e.preventDefault();
        }
        return;
      }

      if (key === "ArrowLeft") {
        if (audioRef.current && playingTrackId) {
          const current = audioRef.current.currentTime || 0;
          audioRef.current.currentTime = Math.max(0, current - 2);
          e.preventDefault();
        }
        return;
      }

      if (key === "ArrowRight") {
        if (audioRef.current && playingTrackId) {
          const current = audioRef.current.currentTime || 0;
          const duration = audioRef.current.duration;
          let newTime = current + 2;
          if (!Number.isNaN(duration) && duration > 0) {
            newTime = Math.min(duration - 0.2, newTime);
          }
          audioRef.current.currentTime = newTime;
          e.preventDefault();
        }
        return;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [tracks, selectedTrackId, playingTrackId]);

  useEffect(() => {
    if (!selectedTrackId) return;
    const row = rowRefs.current[selectedTrackId];
    if (row) {
      row.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [selectedTrackId]);

  if (loading) {
    return (
      <>
        <style jsx global>{`
          ::-webkit-scrollbar {
            width: 8px;
            height: 8px;
          }
          ::-webkit-scrollbar-track {
            background: #020617;
          }
          ::-webkit-scrollbar-thumb {
            background: #1f2937;
            border-radius: 999px;
          }
          ::-webkit-scrollbar-thumb:hover {
            background: #4b5563;
          }
          body {
            scrollbar-color: #1f2937 #020617;
            scrollbar-width: thin;
          }
        `}</style>
        <main
          style={{
            minHeight: "100vh",
            padding: "1.4rem 2rem 0.2rem",
            fontFamily: "sans-serif",
            background: "#050816",
            color: "#f9fafb",
          }}
        >
          <h1 style={{ fontSize: "1.8rem", marginBottom: "0.4rem" }}>
            Crate Digger
          </h1>
          <p style={{ fontSize: "0.9rem" }}>Loading...</p>
        </main>
      </>
    );
  }

  if (authError) {
    return (
      <>
        <style jsx global>{`
          ::-webkit-scrollbar {
            width: 8px;
            height: 8px;
          }
          ::-webkit-scrollbar-track {
            background: #020617;
          }
          ::-webkit-scrollbar-thumb {
            background: #1f2937;
            border-radius: 999px;
          }
          ::-webkit-scrollbar-thumb:hover {
            background: #4b5563;
          }
          body {
            scrollbar-color: #1f2937 #020617;
            scrollbar-width: thin;
          }
        `}</style>
        <main
          style={{
            minHeight: "100vh",
            padding: "2rem",
            fontFamily: "sans-serif",
            background: "#050816",
            color: "#f9fafb",
          }}
        >
          <h1 style={{ fontSize: "1.8rem", marginBottom: "0.4rem" }}>
            Crate Digger
          </h1>
          <p style={{ fontSize: "0.9rem" }}>You are not logged in.</p>
          <button
            type="button"
            onClick={handleLogin}
            style={{
              marginTop: "1rem",
              padding: "0.7rem 1.4rem",
              fontSize: "0.9rem",
              borderRadius: "999px",
              border: "none",
              cursor: "pointer",
              fontWeight: 600,
            }}
          >
            Log in with Spotify
          </button>
        </main>
      </>
    );
  }

  const ownedPlaylists: Playlist[] = currentUserId
    ? playlists.filter((pl) => pl.ownerId === currentUserId)
    : [];

  const mainLayoutWrapperStyle = isMobile
    ? {
        display: "flex",
        flexDirection: "column" as const,
        gap: "0.9rem",
        marginTop: "0.9rem",
      }
    : {
        display: "flex",
        gap: "1.25rem",
        marginTop: "0.75rem",
      };

  const playlistPanelStyle = {
    flex: "0 0 300px",
    maxHeight: "82vh",
    overflowY: "auto" as const,
    border: "1px solid #1f2933",
    borderRadius: "0.75rem",
    padding: "0.75rem",
    background: "#0b1020",
  };

  const tracksPanelStyle = isMobile
    ? {
        flex: 1,
        border: "1px solid #1f2933",
        borderRadius: "0.75rem",
        padding: "0.7rem 0.9rem 0.9rem",
        background: "#0b1020",
        outline: "none",
      }
    : {
        flex: 1,
        maxHeight: "82vh",
        overflowY: "auto" as const,
        border: "1px solid #1f2933",
        borderRadius: "0.75rem",
        padding: "0.7rem 0.9rem",
        background: "#0b1020",
        outline: "none",
      };

  const mobilePlaylistOverlayStyle = {
    position: "fixed" as const,
    inset: 0,
    zIndex: 40,
    background:
      "linear-gradient(to bottom, rgba(15,23,42,0.98), rgba(5,8,22,0.98))",
    display: isMobile && showPlaylists ? "flex" : "none",
    flexDirection: "column" as const,
    padding: "1rem",
  };

  const mobilePlaylistHeaderStyle = {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: "0.7rem",
  };

  const mobilePlaylistScrollStyle = {
    flex: 1,
    overflowY: "auto" as const,
    borderRadius: "0.75rem",
    border: "1px solid #1f2933",
    padding: "0.6rem",
    background: "#020617",
  };

  const mobileDestPadStyle = {
    position: "fixed" as const,
    left: 0,
    right: 0,
    bottom: 0,
    padding: "0.45rem 1rem 0.7rem",
    background:
      "linear-gradient(to top, rgba(5,8,22,0.97), rgba(5,8,22,0.93))",
    borderTop: "1px solid #1f2933",
    boxShadow: "0 -10px 25px rgba(0,0,0,0.75)",
    zIndex: 30,
  };

  const mobileDestGridStyle = {
    display: "grid",
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    gap: "0.45rem",
    marginTop: "0.4rem",
  };

  const mobileDestSheetOverlayStyle = {
    position: "fixed" as const,
    inset: 0,
    zIndex: 45,
    background: "rgba(15,23,42,0.85)",
    display: isMobile && showDestinationsSheet ? "flex" : "none",
    justifyContent: "flex-end",
  };

  const mobileDestSheetStyle = {
    width: "100%",
    maxHeight: "70vh",
    background: "#020617",
    borderTopLeftRadius: "1rem",
    borderTopRightRadius: "1rem",
    padding: "0.8rem 1rem 0.7rem",
    boxShadow: "0 -12px 32px rgba(0,0,0,0.75)",
    borderTop: "1px solid #1f2933",
  };

  const playlistHeaderButtonStyle = {
    padding: isMobile ? "0.35rem 0.9rem" : "0.4rem 1.1rem",
    borderRadius: "999px",
    border: "1px solid #4b5563",
    background: "#020617",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
  } as const;

  const renderPlaylistsList = () => (
    <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
      {playlists.map((pl) => {
        const isSelected = pl.id === selectedPlaylistId;
        const ownerName = pl.ownerName;
        return (
          <li
            key={pl.id}
            onClick={() => {
              handleSelectPlaylist(pl);
              focusTracks();
            }}
            style={{
              display: "flex",
              alignItems: "center",
              marginBottom: isMobile ? "0.25rem" : "0.45rem",
              padding: isMobile ? "0.3rem 0.4rem" : "0.35rem 0.45rem",
              borderRadius: "0.5rem",
              cursor: "pointer",
              background: isSelected ? "#111827" : "transparent",
              border: isSelected
                ? "1px solid #4b5563"
                : "1px solid transparent",
            }}
          >
            {pl.images && pl.images[0] && (
              <img
                src={pl.images[0].url}
                alt={pl.name}
                style={{
                  width: isMobile ? "56px" : "44px",
                  height: isMobile ? "56px" : "44px",
                  objectFit: "cover",
                  borderRadius: "0.4rem",
                  marginRight: "0.55rem",
                  flexShrink: 0,
                }}
              />
            )}
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  gap: "0.3rem",
                  marginBottom: "0.02rem",
                }}
              >
                <span
                  style={{
                    fontSize: "0.9rem",
                    fontWeight: 500,
                    lineHeight: 1.2,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {pl.name}
                </span>
                {ownerName && (
                  <span
                    style={{
                      fontSize: "0.75rem",
                      color: "#6b7280",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      maxWidth: "8rem",
                    }}
                  >
                    · {ownerName}
                  </span>
                )}
              </div>
              <div
                style={{
                  fontSize: "0.75rem",
                  color: "#9ca3af",
                }}
              >
                {pl.tracks?.total ?? 0} tracks
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );

  const renderDestinationsConfig = () => (
    <div
      style={{
        display: "flex",
        gap: "0.75rem",
        flexWrap: "wrap",
      }}
    >
      {destinations.map((slot) => {
        const ownedHasPlaylist =
          slot.playlistId &&
          ownedPlaylists.some((pl) => pl.id === slot.playlistId);

        const selectValue =
          slot.mode === "existing" && slot.playlistId
            ? slot.playlistId
            : slot.mode === "new"
            ? "__new__"
            : "";

        const color = SLOT_COLORS[slot.id] || "#4b5563";
        const isSourcePlaylist =
          !!selectedPlaylistId && slot.playlistId === selectedPlaylistId;

        const selectedPlaylist = slot.playlistId
          ? playlists.find((pl) => pl.id === slot.playlistId)
          : undefined;

        const coverUrl =
          selectedPlaylist?.images && selectedPlaylist.images[0]
            ? selectedPlaylist.images[0].url
            : null;

        return (
          <div
            key={slot.id}
            style={{
              flex: "1 1 200px",
              minWidth: "200px",
              border: "1px solid #1f2933",
              borderRadius: "0.85rem",
              padding: "0.9rem 0.9rem 0.7rem",
              background: "#020617",
              boxShadow: `0 0 0 1px rgba(15,23,42,0.6)`,
              position: "relative",
            }}
          >
            <div
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                height: "3px",
                borderTopLeftRadius: "0.85rem",
                borderTopRightRadius: "0.85rem",
                background: color,
              }}
            />

            <div
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: "0.7rem",
              }}
            >
              <div
                style={{
                  width: "64px",
                  height: "64px",
                  borderRadius: "0.6rem",
                  background: "#020617",
                  border: "1px solid #1f2933",
                  overflow: "hidden",
                  flexShrink: 0,
                }}
              >
                {coverUrl && (
                  <img
                    src={coverUrl}
                    alt={selectedPlaylist?.name || "Playlist cover"}
                    style={{
                      width: "100%",
                      height: "100%",
                      objectFit: "cover",
                    }}
                  />
                )}
              </div>

              <div style={{ minWidth: 0, flex: 1 }}>
                <div
                  style={{
                    fontSize: "0.8rem",
                    color: "#e5e7eb",
                    fontWeight: 500,
                    marginBottom: "0.15rem",
                  }}
                >
                  Slot {slot.id}
                </div>

                <select
                  value={selectValue}
                  onChange={(e) => {
                    handleDestinationSelectChange(slot.id, e.target.value);
                    focusTracks();
                  }}
                  style={{
                    width: "100%",
                    padding: "0.42rem 0.6rem",
                    borderRadius: "0.6rem",
                    border: isSourcePlaylist
                      ? "2px solid #ef4444"
                      : "1px solid #374151",
                    background: "#020617",
                    color: "#e5e7eb",
                    fontSize: "0.8rem",
                  }}
                >
                  <option value="">No destination</option>
                  <option value="__new__">New playlist…</option>

                  <optgroup label="Owned playlists">
                    {ownedPlaylists.map((pl) => (
                      <option key={pl.id} value={pl.id}>
                        {pl.name}
                      </option>
                    ))}
                  </optgroup>

                  {slot.mode === "existing" &&
                    slot.playlistId &&
                    !ownedHasPlaylist && (
                      <option value={slot.playlistId}>
                        {slot.displayName || "(new playlist)"}
                      </option>
                    )}
                </select>

                {isSourcePlaylist && (
                  <div
                    style={{
                      fontSize: "0.75rem",
                      color: "#f87171",
                      marginTop: "0.25rem",
                    }}
                  >
                    This is the source playlist (send is disabled).
                  </div>
                )}

                {slot.mode === "new" && (
                  <div style={{ marginTop: "0.35rem" }}>
                    <div
                      style={{
                        display: "flex",
                        gap: "0.4rem",
                        alignItems: "center",
                      }}
                    >
                      <input
                        type="text"
                        value={slot.newName}
                        onChange={(e) =>
                          handleDestinationNewNameChange(
                            slot.id,
                            e.target.value
                          )
                        }
                        placeholder="e.g. Crate Digger Picks"
                        style={{
                          flex: 1,
                          padding: "0.38rem 0.6rem",
                          borderRadius: "0.6rem",
                          border: "1px solid #374151",
                          background: "#020617",
                          color: "#e5e7eb",
                          fontSize: "0.8rem",
                        }}
                      />
                      <button
                        onClick={() => {
                          handleCreatePlaylistForSlot(slot.id);
                          focusTracks();
                        }}
                        style={{
                          padding: "0.3rem 0.55rem",
                          borderRadius: "0.6rem",
                          border: "1px solid #4b5563",
                          background: "#111827",
                          color: "#e5e7eb",
                          fontSize: "0.9rem",
                          cursor: "pointer",
                          lineHeight: 1,
                        }}
                        title="Create playlist with this name"
                      >
                        +
                      </button>
                    </div>
                  </div>
                )}

                <div
                  style={{
                    fontSize: "0.75rem",
                    color: "#6b7280",
                    marginTop: "0.35rem",
                  }}
                >
                  Sent this session: {slot.sentTrackIds.length}
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );

  return (
    <>
      <style jsx global>{`
        ::-webkit-scrollbar {
          width: 8px;
          height: 8px;
        }
        ::-webkit-scrollbar-track {
          background: #020617;
        }
        ::-webkit-scrollbar-thumb {
          background: #1f2937;
        }
        ::-webkit-scrollbar-thumb:hover {
          background: #4b5563;
        }
        body {
          scrollbar-color: #1f2937 #020617;
          scrollbar-width: thin;
        }
      `}</style>
      <main
        style={{
          minHeight: "100vh",
          padding: isMobile ? "1rem 1.2rem 0.4rem" : "1.4rem 2rem 0.2rem",
          fontFamily: "sans-serif",
          background: "#050816",
          color: "#f9fafb",
          paddingBottom: isMobile ? "4.2rem" : "1.4rem",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "1rem",
            marginBottom: isMobile ? "0.2rem" : "0.3rem",
          }}
        >
          <h1 style={{ fontSize: isMobile ? "1.4rem" : "1.8rem" }}>
            Crate Digger
          </h1>
          <button
            onClick={handleLogout}
            style={{
              padding: isMobile ? "0.35rem 0.8rem" : "0.45rem 0.9rem",
              borderRadius: "999px",
              border: "1px solid #4b5563",
              background: "#0b1020",
              color: "#e5e7eb",
              fontSize: "0.8rem",
              cursor: "pointer",
              fontWeight: 500,
            }}
          >
            Log out
          </button>
        </div>

        {isMobile && (
          <div style={mobilePlaylistOverlayStyle}>
            <div style={mobilePlaylistHeaderStyle}>
              <div>
                <h2
                  style={{
                    fontSize: "1rem",
                    margin: 0,
                    color: "#e5e7eb",
                  }}
                >
                  Your Playlists
                </h2>
                <p
                  style={{
                    margin: 0,
                    marginTop: "0.15rem",
                    fontSize: "0.75rem",
                    color: "#9ca3af",
                  }}
                >
                  Tap a playlist to load it.
                </p>
              </div>
              <button
                onClick={() => setShowPlaylists(false)}
                style={{
                  padding: "0.3rem 0.8rem",
                  borderRadius: "999px",
                  border: "1px solid #4b5563",
                  background: "#020617",
                  color: "#e5e7eb",
                  fontSize: "0.8rem",
                  cursor: "pointer",
                }}
              >
                Close
              </button>
            </div>
            <div style={mobilePlaylistScrollStyle}>{renderPlaylistsList()}</div>
          </div>
        )}

        {isMobile && (
          <div style={mobileDestSheetOverlayStyle}>
            <div style={mobileDestSheetStyle}>
              <div
                style={{
                  width: "42px",
                  height: "4px",
                  borderRadius: "999px",
                  background: "#4b5563",
                  margin: "0 auto 0.4rem",
                }}
              />
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginBottom: "0.4rem",
                }}
              >
                <div>
                  <h2
                    style={{
                      margin: 0,
                      fontSize: "0.9rem",
                      color: "#e5e7eb",
                    }}
                  >
                    Destination slots
                  </h2>
                  <p
                    style={{
                      margin: 0,
                      marginTop: "0.12rem",
                      fontSize: "0.75rem",
                      color: "#9ca3af",
                    }}
                  >
                    Choose playlists for slots 1–6.
                  </p>
                </div>
                <button
                  onClick={() => setShowDestinationsSheet(false)}
                  style={{
                    padding: "0.25rem 0.7rem",
                    borderRadius: "999px",
                    border: "1px solid #4b5563",
                    background: "#0b1020",
                    color: "#e5e7eb",
                    fontSize: "0.8rem",
                    cursor: "pointer",
                  }}
                >
                  Done
                </button>
              </div>
              <div style={{ marginTop: "0.4rem" }}>
                {renderDestinationsConfig()}
              </div>
            </div>
          </div>
        )}

        <div style={mainLayoutWrapperStyle}>
          {!isMobile && showPlaylists && (
            <div style={playlistPanelStyle}>
              <h2
                style={{
                  fontSize: "0.95rem",
                  margin: "0 0 0.6rem 0",
                  color: "#9ca3af",
                }}
              >
                Your Playlists
              </h2>
              {renderPlaylistsList()}
            </div>
          )}

          <div ref={tracksContainerRef} tabIndex={-1} style={tracksPanelStyle}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "0.75rem",
                marginBottom: "0.5rem",
                flexWrap: "wrap",
              }}
            >
              <div>
                {selectedPlaylistName ? (
                  <button
                    onClick={() => setShowPlaylists((prev) => !prev)}
                    style={playlistHeaderButtonStyle}
                  >
                    <span
                      style={{
                        fontSize: isMobile ? "1rem" : "1.05rem",
                        fontWeight: 600,
                        color: "#e5e7eb",
                      }}
                    >
                      {selectedPlaylistName}
                    </span>
                  </button>
                ) : (
                  <button
                    onClick={() => setShowPlaylists(true)}
                    style={playlistHeaderButtonStyle}
                  >
                    <span
                      style={{
                        fontSize: isMobile ? "0.95rem" : "1rem",
                        fontWeight: 500,
                        color: "#e5e7eb",
                      }}
                    >
                      Select a playlist
                    </span>
                  </button>
                )}
              </div>

              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.35rem",
                  fontSize: isMobile ? "0.85rem" : "0.75rem",
                  color: "#6b7280",
                  cursor: "pointer",
                  userSelect: "none",
                  whiteSpace: "nowrap",
                  marginLeft: "auto",
                }}
              >
                <input
                  type="checkbox"
                  checked={autoRemoveOnSend}
                  onChange={(e) => setAutoRemoveOnSend(e.target.checked)}
                  style={{
                    width: isMobile ? "15px" : "13px",
                    height: isMobile ? "15px" : "13px",
                    accentColor: "#22c55e",
                    cursor: "pointer",
                  }}
                />
                <span>Remove on send</span>
              </label>
            </div>

            {loadingTracks && selectedPlaylistId && (
              <p style={{ fontSize: "0.85rem" }}>Loading tracks...</p>
            )}

            {!loadingTracks && selectedPlaylistId && tracks.length === 0 && (
              <p style={{ color: "#9ca3af", fontSize: "0.85rem" }}>
                No tracks found.
              </p>
            )}

            {!selectedPlaylistId && (
              <p style={{ color: "#9ca3af", fontSize: "0.85rem" }}>
                Tap <strong>Select a playlist</strong> above to start.
              </p>
            )}

            {!loadingTracks && selectedPlaylistId && tracks.length > 0 && (
              <>
                {!isMobile && (
                  <table
                    style={{
                      width: "100%",
                      borderCollapse: "collapse",
                      fontSize: "0.85rem",
                      tableLayout: "fixed",
                    }}
                  >
                    <thead>
                      <tr>
                        <th
                          style={{
                            textAlign: "left",
                            padding: "0.35rem",
                            borderBottom: "1px solid #1f2933",
                            width: "2.5rem",
                          }}
                        >
                          #
                        </th>
                        <th
                          style={{
                            textAlign: "left",
                            padding: "0.35rem",
                            borderBottom: "1px solid #1f2933",
                            width: "3rem",
                          }}
                        >
                          ▶
                        </th>
                        <th
                          style={{
                            textAlign: "left",
                            padding: "0.35rem",
                            borderBottom: "1px solid #1f2933",
                            width: "33%",
                          }}
                        >
                          Title / Artist
                        </th>
                        <th
                          style={{
                            textAlign: "center",
                            padding: "0.35rem",
                            borderBottom: "1px solid #1f2933",
                            borderLeft: "1px solid #111827",
                            borderRight: "1px solid #111827",
                            width: "16%",
                            maxWidth: "170px",
                          }}
                        >
                          Destinations
                        </th>
                        <th
                          style={{
                            textAlign: "center",
                            padding: "0.35rem",
                            borderBottom: "1px solid #1f2933",
                            width: "8%",
                          }}
                        >
                          BPM
                        </th>
                        <th
                          style={{
                            textAlign: "left",
                            padding: "0.35rem 0.35rem 0.35rem 1.1rem",
                            borderBottom: "1px solid #1f2933",
                            borderLeft: "1px solid #111827",
                            width: "31%",
                          }}
                        >
                          Genres
                        </th>
                        <th
                          style={{
                            textAlign: "center",
                            padding: "0.35rem",
                            borderBottom: "1px solid #1f2933",
                            width: "7%",
                          }}
                        >
                          Spotify
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {tracks.map((t, index) => {
                        const isPlaying = t.id === playingTrackId;
                        const isSelectedTrack = t.id === selectedTrackId;
                        const isActiveForSpotify =
                          t.id === selectedTrackId || t.id === playingTrackId;
                        return (
                          <tr
                            key={t.id || `${index}-${t.name}`}
                            ref={(el) => {
                              rowRefs.current[t.id] = el;
                            }}
                            style={{
                              backgroundColor: isSelectedTrack
                                ? "#020617"
                                : "transparent",
                            }}
                          >
                            <td
                              style={{
                                padding: "0.28rem 0.35rem",
                                borderBottom: "1px solid #1f2933",
                                width: "2.5rem",
                              }}
                            >
                              {index + 1}
                            </td>
                            <td
                              style={{
                                padding: "0.28rem 0.35rem",
                                borderBottom: "1px solid #1f2933",
                                width: "3rem",
                              }}
                            >
                              <button
                                onClick={() => {
                                  setSelectedTrackId(t.id);
                                  handlePreviewClick(t);
                                }}
                                style={{
                                  padding: "0.12rem 0.35rem",
                                  fontSize: "0.7rem",
                                  borderRadius: "999px",
                                  border: "1px solid #4b5563",
                                  background: isPlaying
                                    ? "#4b5563"
                                    : "transparent",
                                  color: "#f9fafb",
                                  cursor: "pointer",
                                }}
                              >
                                {isPlaying ? "⏹" : "▶"}
                              </button>
                            </td>
                            <td
                              onClick={() => handleTrackNameClick(t)}
                              style={{
                                padding: "0.28rem 0.35rem",
                                borderBottom: "1px solid #1f2933",
                                cursor: "pointer",
                                width: "33%",
                                overflow: "hidden",
                              }}
                            >
                              <div
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: "0.55rem",
                                  overflow: "hidden",
                                }}
                              >
                                {t.albumImageUrl && (
                                  <img
                                    src={t.albumImageUrl}
                                    alt={t.name}
                                    style={{
                                      width: "34px",
                                      height: "34px",
                                      objectFit: "cover",
                                      borderRadius: "0.35rem",
                                      flexShrink: 0,
                                    }}
                                  />
                                )}
                                <div
                                  style={{
                                    overflow: "hidden",
                                    whiteSpace: "nowrap",
                                  }}
                                >
                                  <div
                                    style={{
                                      fontWeight: 500,
                                      fontSize: "0.9rem",
                                      marginBottom: "0.03rem",
                                      overflow: "hidden",
                                      textOverflow: "ellipsis",
                                    }}
                                  >
                                    {t.name}
                                  </div>
                                  <div
                                    style={{
                                      fontSize: "0.8rem",
                                      color: "#9ca3af",
                                      overflow: "hidden",
                                      textOverflow: "ellipsis",
                                    }}
                                  >
                                    {t.artists.map((a) => a.name).join(", ")}
                                  </div>
                                </div>
                              </div>
                            </td>
                            <td
                              style={{
                                padding: "0.28rem 0.35rem",
                                borderBottom: "1px solid #1f2933",
                                borderLeft: "1px solid #111827",
                                borderRight: "1px solid #111827",
                                textAlign: "center",
                                minHeight: "40px",
                                width: "16%",
                              }}
                            >
                              {isSelectedTrack && (
                                <div
                                  style={{
                                    display: "grid",
                                    gridTemplateColumns:
                                      "repeat(3, minmax(0, 1fr))",
                                    gap: "0.25rem",
                                    justifyItems: "stretch",
                                  }}
                                >
                                  {destinations.map((slot) => {
                                    const hasName =
                                      slot.mode === "existing"
                                        ? !!slot.playlistId
                                        : slot.mode === "new"
                                        ? !!slot.displayName.trim()
                                        : false;
                                    const enabled =
                                      slot.mode === "existing" &&
                                      !!slot.playlistId;
                                    const baseColor =
                                      SLOT_COLORS[slot.id] || "#4b5563";

                                    const isRecentlySent =
                                      recentSend &&
                                      recentSend.slotId === slot.id &&
                                      recentSend.trackId === t.id;

                                    const background = enabled
                                      ? isRecentlySent
                                        ? "#f9fafb"
                                        : baseColor
                                      : "#111827";
                                    const color = enabled
                                      ? "#020617"
                                      : hasName
                                      ? "#9ca3af"
                                      : "#4b5563";
                                    const borderColor = enabled
                                      ? baseColor
                                      : "#4b5563";

                                    return (
                                      <button
                                        key={slot.id}
                                        onClick={() =>
                                          enabled &&
                                          handleSendToDestination(slot.id, t)
                                        }
                                        disabled={!enabled}
                                        style={{
                                          padding: "0.18rem 0.2rem",
                                          fontSize: "0.7rem",
                                          borderRadius: "0.35rem",
                                          border: `1px solid ${borderColor}`,
                                          background,
                                          color,
                                          cursor: enabled
                                            ? "pointer"
                                            : "default",
                                          fontWeight: 600,
                                          width: "100%",
                                          transition:
                                            "background 0.15s ease, transform 0.1s ease",
                                          transform: isRecentlySent
                                            ? "scale(1.03)"
                                            : "scale(1)",
                                        }}
                                        title={
                                          enabled
                                            ? `Send to slot ${slot.id} (${
                                                slot.displayName ||
                                                slot.playlistId ||
                                                "unnamed"
                                              })`
                                            : hasName
                                            ? `Create/select playlist for slot ${slot.id} first`
                                            : `Configure slot ${slot.id} in the Destinations section below`
                                        }
                                      >
                                        {slot.id}
                                      </button>
                                    );
                                  })}
                                </div>
                              )}
                            </td>
                            <td
                              style={{
                                padding: "0.28rem 0.35rem",
                                borderBottom: "1px solid #1f2933",
                                textAlign: "center",
                                width: "8%",
                                fontSize: "0.8rem",
                              }}
                            >
                              {t.bpmStatus === "loading" && (
                                <span style={{ opacity: 0.8 }}>…</span>
                              )}
                              {t.bpmStatus !== "loading" &&
                                t.bpm != null &&
                                Number.isFinite(t.bpm) && (
                                  <span>{Math.round(t.bpm)}</span>
                                )}
                              {t.bpmStatus !== "loading" &&
                                (t.bpm == null || !Number.isFinite(t.bpm)) && (
                                  <span style={{ color: "#4b5563" }}>–</span>
                                )}
                            </td>
                            <td
                              style={{
                                padding: "0.28rem 0.35rem 0.28rem 1.1rem",
                                borderBottom: "1px solid #1f2933",
                                borderLeft: "1px solid #111827",
                                fontSize: "0.8rem",
                                color: "#9ca3af",
                                width: "31%",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {formatGenres(t.genres)}
                            </td>
                            <td
                              style={{
                                padding: "0.28rem 0.35rem",
                                borderBottom: "1px solid #1f2933",
                                textAlign: "center",
                                width: "7%",
                              }}
                            >
                              {isActiveForSpotify && t.id && (
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    window.location.href =
                                      `https://open.spotify.com/track/${t.id}`;
                                  }}
                                  style={{
                                    padding: "0.2rem 0.6rem",
                                    borderRadius: "999px",
                                    border: "1px solid #22c55e",
                                    background: "#022c22",
                                    color: "#bbf7d0",
                                    fontSize: "0.7rem",
                                    cursor: "pointer",
                                    fontWeight: 600,
                                    whiteSpace: "nowrap",
                                  }}
                                  title="Open in Spotify"
                                >
                                  Spotify
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}

                {isMobile && (
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: "0.35rem",
                      paddingBottom: "0.6rem",
                    }}
                  >
                    {tracks.map((t, index) => {
                      const isPlaying = t.id === playingTrackId;
                      const isSelectedTrack = t.id === selectedTrackId;
                      const isActiveForSpotify =
                        t.id === selectedTrackId || t.id === playingTrackId;
                      return (
                        <div
                          key={t.id || `${index}-${t.name}`}
                          onClick={() => setSelectedTrackId(t.id)}
                          style={{
                            borderRadius: "0.75rem",
                            border: isSelectedTrack
                              ? "1px solid #4b5563"
                              : "1px solid #111827",
                            background: "#020617",
                            padding: "0.45rem 0.6rem 0.35rem",
                            display: "flex",
                            flexDirection: "column",
                            gap: "0.25rem",
                          }}
                        >
                          <div
                            style={{
                              display: "grid",
                              gridTemplateColumns:
                                "minmax(0, 1.1fr) minmax(0, 2fr) auto",
                              columnGap: "0.6rem",
                              alignItems: "center",
                            }}
                          >
                            {/* Left ~1/3 area: preview (clickable) */}
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setSelectedTrackId(t.id);
                                handlePreviewClick(t);
                              }}
                              style={{
                                padding: 0,
                                margin: 0,
                                border: "none",
                                background: "transparent",
                                cursor: "pointer",
                                width: "100%",
                                justifySelf: "flex-start",
                                display: "flex",
                                justifyContent: "flex-start",
                              }}
                            >
                              <div
                                style={{
                                  position: "relative",
                                  width: "64px",
                                  height: "64px",
                                  borderRadius: "0.6rem",
                                  overflow: "hidden",
                                  background: "#020617",
                                  border: "1px solid #111827",
                                }}
                              >
                                {t.albumImageUrl && (
                                  <img
                                    src={t.albumImageUrl}
                                    alt={t.name}
                                    style={{
                                      width: "100%",
                                      height: "100%",
                                      objectFit: "cover",
                                      display: "block",
                                    }}
                                  />
                                )}
                                <div
                                  style={{
                                    position: "absolute",
                                    inset: 0,
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    pointerEvents: "none",
                                  }}
                                >
                                  <div
                                    style={{
                                      width: "26px",
                                      height: "26px",
                                      borderRadius: "999px",
                                      background: "rgba(15,23,42,0.6)",
                                      display: "flex",
                                      alignItems: "center",
                                      justifyContent: "center",
                                      fontSize: "0.9rem",
                                      color: "#f9fafb",
                                    }}
                                  >
                                    {isPlaying ? "❚❚" : "▶"}
                                  </div>
                                </div>
                              </div>
                            </button>

                            {/* Middle: title / artist / bpm / genres */}
                            <div
                              style={{
                                minWidth: 0,
                                overflow: "hidden",
                              }}
                            >
                              <div
                                style={{
                                  fontWeight: 500,
                                  fontSize: "0.95rem",
                                  whiteSpace: "nowrap",
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  marginBottom: "0.06rem",
                                }}
                              >
                                {t.name}
                              </div>
                              <div
                                style={{
                                  fontSize: "0.8rem",
                                  color: "#9ca3af",
                                  whiteSpace: "nowrap",
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                }}
                              >
                                {t.artists.map((a) => a.name).join(", ")}
                              </div>
                              <div
                                style={{
                                  marginTop: "0.2rem",
                                  fontSize: "0.7rem",
                                  color: "#6b7280",
                                  whiteSpace: "nowrap",
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                }}
                              >
                                {t.bpmStatus === "loading"
                                  ? "Detecting BPM… · "
                                  : t.bpm != null &&
                                    Number.isFinite(t.bpm) &&
                                    `${Math.round(t.bpm)} BPM · `}
                                {formatGenres(t.genres)}
                              </div>
                            </div>

                            {/* Right: Spotify button (top-right of card) */}
                            {isActiveForSpotify && t.id && (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  window.location.href =
                                    `https://open.spotify.com/track/${t.id}`;
                                }}
                                style={{
                                  padding: "0.2rem 0.55rem",
                                  borderRadius: "999px",
                                  border: "1px solid #22c55e",
                                  background: "#022c22",
                                  color: "#bbf7d0",
                                  fontSize: "0.7rem",
                                  cursor: "pointer",
                                  fontWeight: 600,
                                  whiteSpace: "nowrap",
                                  alignSelf: "flex-start",
                                  justifySelf: "flex-end",
                                }}
                                title="Open in Spotify"
                              >
                                Spotify
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {!isMobile && (
          <div
            style={{
              marginTop: "0.6rem",
              borderTop: "1px solid #1f2933",
              paddingTop: "0.45rem",
            }}
          >
            {renderDestinationsConfig()}
          </div>
        )}

        {isMobile && (
          <div style={mobileDestPadStyle}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: "0.25rem",
                gap: "0.5rem",
              }}
            >
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.05rem",
                }}
              >
                <span
                  style={{
                    fontSize: "0.8rem",
                    color: "#e5e7eb",
                  }}
                >
                  Destinations
                </span>
                <span
                  style={{
                    fontSize: "0.7rem",
                    color: "#9ca3af",
                  }}
                >
                  Tap a slot to send the active track.
                </span>
              </div>
              <button
                onClick={() => setShowDestinationsSheet(true)}
                style={{
                  padding: "0.28rem 0.7rem",
                  borderRadius: "999px",
                  border: "1px solid #4b5563",
                  background: "#020617",
                  color: "#e5e7eb",
                  fontSize: "0.75rem",
                  cursor: "pointer",
                  fontWeight: 500,
                  whiteSpace: "nowrap",
                }}
              >
                Configure
              </button>
            </div>
            <div style={mobileDestGridStyle}>
              {destinations.map((slot) => {
                const activeTrack = getActiveTrack();
                const hasName =
                  slot.mode === "existing"
                    ? !!slot.playlistId
                    : slot.mode === "new"
                    ? !!slot.displayName.trim()
                    : false;

                const isSourcePlaylist =
                  !!selectedPlaylistId &&
                  slot.playlistId === selectedPlaylistId;

                const enabled =
                  slot.mode === "existing" &&
                  !!slot.playlistId &&
                  !isSourcePlaylist;

                const baseColor = SLOT_COLORS[slot.id] || "#4b5563";

                const isRecentlySent =
                  activeTrack &&
                  recentSend &&
                  recentSend.slotId === slot.id &&
                  recentSend.trackId === activeTrack.id;

                const background = enabled
                  ? isRecentlySent
                    ? "#f9fafb"
                    : baseColor
                  : "#020617";
                const color = enabled
                  ? "#020617"
                  : hasName
                  ? "#9ca3af"
                  : "#4b5563";
                const borderColor = enabled ? baseColor : "#4b5563";

                const label =
                  slot.displayName ||
                  (hasName ? "(unnamed)" : "No playlist");

                return (
                  <button
                    key={slot.id}
                    onClick={() => {
                      if (!enabled) return;
                      const track = getActiveTrack();
                      if (!track) {
                        console.log("No active track selected to send.");
                        return;
                      }
                      handleSendToDestination(slot.id, track);
                    }}
                    style={{
                      padding: "0.4rem 0.4rem 0.45rem",
                      borderRadius: "0.6rem",
                      border: `1px solid ${borderColor}`,
                      background,
                      color,
                      cursor: enabled ? "pointer" : "default",
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "flex-start",
                      justifyContent: "center",
                      transition: "background 0.15s ease, transform 0.1s ease",
                      transform: isRecentlySent ? "scale(1.03)" : "scale(1)",
                    }}
                  >
                    <span
                      style={{
                        fontSize: "0.75rem",
                        fontWeight: 600,
                        marginBottom: "0.08rem",
                      }}
                    >
                      Slot {slot.id}
                    </span>
                    <span
                      style={{
                        fontSize: "0.72rem",
                        opacity: enabled ? 0.95 : 0.7,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        maxWidth: "100%",
                      }}
                    >
                      {label}
                    </span>
                    {isSourcePlaylist && (
                      <span
                        style={{
                          marginTop: "0.05rem",
                          fontSize: "0.7rem",
                          color: "#fca5a5",
                        }}
                      >
                        Source playlist
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </main>
    </>
  );
}
