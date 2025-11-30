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
  preview_url: string | null; // Spotify preview, if any
  albumImageUrl: string | null;
  bpm?: number | null;
  bpmStatus?: "idle" | "loading" | "error";
};

type DestinationMode = "none" | "existing" | "new";

type DestinationSlot = {
  id: number; // 1..6
  mode: DestinationMode;
  playlistId: string | null; // existing playlist ID (if mode === "existing")
  displayName: string; // what we show in UI
  newName: string; // typed name if mode === "new"
  sentTrackIds: string[]; // local dedupe in this session
};

// Color coding per destination slot
const SLOT_COLORS: Record<number, string> = {
  1: "#22c55e", // green
  2: "#3b82f6", // blue
  3: "#eab308", // yellow
  4: "#f97316", // orange
  5: "#a855f7", // purple
  6: "#ec4899", // pink
};

export default function Home() {
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

  // preview player state
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playingTrackId, setPlayingTrackId] = useState<string | null>(null);

  // which track (row) is "selected" – used to show destination buttons
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null);

  // cache of extra previews we got from iTunes: trackId -> url or null (already tried)
  const [previewOverrides, setPreviewOverrides] = useState<
    Record<string, string | null>
  >({});

  // last time we made an iTunes request (for throttling)
  const lastItunesRequestTime = useRef<number | null>(null);

  // Used to prevent race conditions when hammering arrows:
  // Only the latest preview request is allowed to start audio.
  const previewRequestIdRef = useRef(0);

  // Whether arrow navigation should auto-play the new track
  const followPlaybackRef = useRef(false);

  // AudioContext for BPM detection
  const audioContextRef = useRef<AudioContext | null>(null);

  // 6 destination slots at the bottom
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

  // recent send for visual flash: {slotId, trackId}
  const [recentSend, setRecentSend] = useState<{
    slotId: number;
    trackId: string;
  } | null>(null);

  // Auto-remove from source playlist after successful send (or duplicate)
  const [autoRemoveOnSend, setAutoRemoveOnSend] = useState(false);

  // Row refs for auto-scroll: trackId -> <tr>
  const rowRefs = useRef<Record<string, HTMLTableRowElement | null>>({});

  // ref for tracks container to restore focus
  const tracksContainerRef = useRef<HTMLDivElement | null>(null);

  // show/hide playlist sidebar
  const [showPlaylists, setShowPlaylists] = useState(true);

  const focusTracks = () => {
    if (tracksContainerRef.current) {
      tracksContainerRef.current.focus();
    }
  };

  // Init AudioContext (client-side only)
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

  // Helper: detect BPM from a preview URL using web-audio-beat-detector
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

  // Initial playlists fetch
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
    // Hard reset to clear client state
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

    // stop any playing audio when switching playlists
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
            track.album?.images?.[0]?.url ?? null; // album cover

          return {
            id: track.id,
            uri: track.uri, // Spotify URI needed to add to playlists
            name: track.name,
            artists: track.artists || [],
            duration_ms: track.duration_ms,
            genres: item.artist_genres || [],
            preview_url: track.preview_url ?? null, // Spotify only here
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

  const handlePreviewClick = async (track: Track) => {
    // If clicking the currently playing track -> stop and disable looping
    if (playingTrackId === track.id) {
      // Cancel any pending async preview for this track
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

    // If some OTHER track is currently playing, immediately stop it
    if (playingTrackId && playingTrackId !== track.id && audioRef.current) {
      previewRequestIdRef.current += 1; // cancel any pending older preview
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      audioRef.current.loop = false;
      audioRef.current.removeAttribute("src");
      audioRef.current.load();
      setPlayingTrackId(null);
    }

    // New preview request: bump global request id and capture a local copy
    const myRequestId = ++previewRequestIdRef.current;

    // Mark this track as selected when we start playback intent
    setSelectedTrackId(track.id);

    // 1) Check if we already have a URL (Spotify or cached iTunes)
    let url: string | null =
      track.preview_url ||
      (typeof previewOverrides[track.id] === "string"
        ? (previewOverrides[track.id] as string)
        : null);

    // 2) If we already tried iTunes and failed (null cached), stop
    if (!url && previewOverrides[track.id] === null) {
      followPlaybackRef.current = false;
      return;
    }

    // 3) If still no URL, call our /api/itunes-preview endpoint with throttle
    if (!url) {
      const mainArtistName = track.artists?.[0]?.name ?? "";

      try {
        // throttle iTunes calls: keep a minimum gap between requests
        const now = Date.now();
        const minGap = 300; // ms -> about 3 requests per second max
        if (lastItunesRequestTime.current != null) {
          const diff = now - lastItunesRequestTime.current;
          if (diff < minGap) {
            await new Promise((resolve) => setTimeout(resolve, minGap - diff));
          }
        }
        lastItunesRequestTime.current = Date.now();

        const params = new URLSearchParams({
          trackName: track.name,
          artistName: mainArtistName,
        });

        const res = await fetch(`/api/itunes-preview?${params.toString()}`);
        if (res.ok) {
          const data = await res.json();
          url = data.previewUrl ?? null;
          setPreviewOverrides((prev) => ({
            ...prev,
            [track.id]: url, // string or null
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

    // 4) If still no URL, there's just no preview available
    if (!url) {
      followPlaybackRef.current = false;
      return;
    }

    // Kick off BPM detection in the background if we haven't yet
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
                  bpm: bpm,
                  bpmStatus: bpm === null ? "error" : "idle",
                }
              : t
          )
        );
      });
    }

    // Before we actually play: if a newer preview request started, abort this one
    if (previewRequestIdRef.current !== myRequestId) {
      return;
    }

    // We're about to start a new preview: navigation should follow playback
    followPlaybackRef.current = true;

    // 5) Play the preview in a loop
    if (!audioRef.current) {
      audioRef.current = new Audio();
    } else {
      // Hard reset the audio element to avoid leftover loads
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      audioRef.current.loop = false;
      audioRef.current.removeAttribute("src");
      audioRef.current.load();
    }

    audioRef.current.src = url;
    audioRef.current.currentTime = 0;
    audioRef.current.loop = true; // loop until user hits stop

    // Another safety check just before playing, in case things changed again
    if (previewRequestIdRef.current !== myRequestId) {
      return;
    }

    audioRef.current
      .play()
      .then(() => {
        // Only mark as playing if this is still the latest request
        if (previewRequestIdRef.current === myRequestId) {
          setPlayingTrackId(track.id);
        }
      })
      .catch((err: any) => {
        // AbortError just means a new preview started and interrupted this one
        if (err?.name === "AbortError") {
          return;
        }
        console.error("Audio play error:", err);
        // If play fails for other reasons, don't keep follow-on-navigation mode
        followPlaybackRef.current = false;
      });
  };

  // Clicking the title/artist area: select + toggle preview
  const handleTrackNameClick = (track: Track) => {
    setSelectedTrackId(track.id);
    handlePreviewClick(track);
  };

  // Handlers for destination slots

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

      // Add new playlist into global playlist list if not already present
      setPlaylists((prev) => {
        if (prev.some((p) => p.id === newPlaylist.id)) return prev;
        return [newPlaylist, ...prev];
      });

      // Switch this slot to existing mode, point to new playlist
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

  // Sending a track to a destination: now ONLY to existing playlists
  const handleSendToDestination = async (slotId: number, track: Track) => {
    const slot = destinations.find((s) => s.id === slotId);
    if (!slot) return;

    // Must be an existing playlist with an ID
    if (slot.mode !== "existing" || !slot.playlistId) {
      console.log(
        `Slot ${slotId} has no playlist yet. Select one or create it with the + button first.`
      );
      return;
    }

    // 🔴 New: If source and destination playlist are the same, skip send & removal
    if (selectedPlaylistId && slot.playlistId === selectedPlaylistId) {
      console.log(
        `Slot ${slotId}: source and destination playlist are the same. Skipping send.`
      );
      return;
    }

    // Simple local dedupe: if we've already sent this track in this session, do nothing
    if (slot.sentTrackIds.includes(track.id)) {
      console.log(
        `Track "${track.name}" is already processed for slot ${slotId} in this session. Skipping.`
      );
      return;
    }

    console.log(
      `Sending track "${track.name}" to slot ${slotId} (playlist: ${
        slot.displayName || slot.playlistId
      }).`
    );

    // 🔔 Optimistic flash: fire immediately on click
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

      // 🔁 Auto-remove behavior (even if duplicate in destination)
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
          // Remove from list
          setTracks((prev) => prev.filter((t) => t.id !== track.id));

          if (nextTrack) {
            // Select and autoplay the next track
            setSelectedTrackId(nextTrack.id);
            handlePreviewClick(nextTrack);
          } else {
            // No next track left: clear selection and stop playback if this was playing
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
          // Really delete from Spotify playlist
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
          // Non-owned playlist: keep the local-only removal behavior
          handleLocalRemovalAndPlayback();
        }
      }

      // Mark this track as sent in this slot
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

  // KEYBOARD CONTROLS
  useEffect(() => {
    const moveSelection = (direction: 1 | -1, shouldPlay: boolean) => {
      if (!tracks.length) return;

      const currentIndex = selectedTrackId
        ? tracks.findIndex((t) => t.id === selectedTrackId)
        : -1;

      // If no selection yet and going down, go to first track
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
        // play the new track
        handlePreviewClick(newTrack);
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore if focused in inputs / textareas / selects / contentEditable
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

      // No modifiers for our controls
      const hasModifier = e.altKey || e.ctrlKey || e.metaKey;
      const key = e.key;

      // Number keys 1–6 => send to destination slots
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
          // No selection yet: down selects first track, no auto-play
          moveSelection(1, false);
        } else {
          // Follow playback intent using ref (not React state)
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

      // Space => play/pause selected track
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

      // Left / Right => seek ±2s in current playing track
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

  // Auto-scroll selected row into view when selection changes
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
          /* Dark scrollbars (WebKit) */
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

          /* Firefox scrollbars */
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
            padding: "1.4rem 2rem 0.2rem",
            fontFamily: "sans-serif",
            background: "#050816",
            color: "#f9fafb",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "1rem",
              marginBottom: "0.4rem",
            }}
          >
            <h1 style={{ fontSize: "1.8rem" }}>Crate Digger</h1>
          </div>
          <p style={{ fontSize: "0.9rem" }}>You are not logged in.</p>
          <button
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

  // Only playlists owned by the current user can be used as destinations
  const ownedPlaylists: Playlist[] = currentUserId
    ? playlists.filter((pl) => pl.ownerId === currentUserId)
    : [];

  return (
    <>
      <style jsx global>{`
        /* Dark scrollbars (WebKit) */
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

        /* Firefox scrollbars */
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
        {/* Top bar: title + logout */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "1rem",
            marginBottom: "0.3rem",
          }}
        >
          <h1 style={{ fontSize: "1.8rem" }}>Crate Digger</h1>
          <button
            onClick={handleLogout}
            style={{
              padding: "0.45rem 0.9rem",
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

        {/* Main two-column layout */}
        <div
          style={{
            display: "flex",
            gap: "1.25rem",
            marginTop: "0.75rem",
          }}
        >
          {/* LEFT: Playlists (hideable) */}
          {showPlaylists && (
            <div
              style={{
                flex: "0 0 260px",
                maxHeight: "82vh",
                overflowY: "auto",
                border: "1px solid #1f2933",
                borderRadius: "0.75rem",
                padding: "0.75rem",
                background: "#0b1020",
              }}
            >
              <h2
                style={{
                  fontSize: "0.95rem",
                  margin: "0 0 0.6rem 0",
                  color: "#9ca3af",
                }}
              >
                Your Playlists
              </h2>
              <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                {playlists.map((pl) => {
                  const isSelected = pl.id === selectedPlaylistId;
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
                        marginBottom: "0.45rem",
                        padding: "0.35rem 0.45rem",
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
                            width: "34px",
                            height: "34px",
                            objectFit: "cover",
                            borderRadius: "0.35rem",
                            marginRight: "0.55rem",
                          }}
                        />
                      )}
                      <div>
                        <div
                          style={{
                            fontSize: "0.9rem",
                            fontWeight: 500,
                            lineHeight: 1.2,
                          }}
                        >
                          {pl.name}
                        </div>
                        <div
                          style={{
                            fontSize: "0.75rem",
                            color: "#9ca3af",
                          }}
                        >
                          {pl.tracks?.total ?? 0} tracks
                        </div>
                        {pl.ownerName && (
                          <div
                            style={{
                              fontSize: "0.7rem",
                              color: "#6b7280",
                            }}
                          >
                            by {pl.ownerName}
                          </div>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {/* RIGHT: Tracks */}
          <div
            ref={tracksContainerRef}
            tabIndex={-1}
            style={{
              flex: 1,
              maxHeight: "82vh",
              overflowY: "auto",
              border: "1px solid #1f2933",
              borderRadius: "0.75rem",
              padding: "0.7rem 0.9rem",
              background: "#0b1020",
              outline: "none",
            }}
          >
            {/* Header row for tracks + playlists toggle + Remove on send */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "0.75rem",
                marginBottom: "0.5rem",
              }}
            >
              <h2
                style={{
                  fontSize: "0.95rem",
                  margin: 0,
                  color: "#9ca3af",
                }}
              >
                {selectedPlaylistName
                  ? `Tracks in "${selectedPlaylistName}"`
                  : "No playlist selected"}
              </h2>

              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.5rem",
                  whiteSpace: "nowrap",
                }}
              >
                <button
                  onClick={() => setShowPlaylists((prev) => !prev)}
                  style={{
                    padding: "0.32rem 0.7rem",
                    borderRadius: "999px",
                    border: "1px solid #4b5563",
                    background: "#0b1020",
                    color: "#e5e7eb",
                    fontSize: "0.78rem",
                    cursor: "pointer",
                    fontWeight: 500,
                  }}
                >
                  {showPlaylists ? "Hide playlists" : "Show playlists"}
                </button>

                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "0.3rem",
                    fontSize: "0.75rem",
                    color: "#6b7280",
                    cursor: "pointer",
                    userSelect: "none",
                    whiteSpace: "nowrap",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={autoRemoveOnSend}
                    onChange={(e) => setAutoRemoveOnSend(e.target.checked)}
                    style={{
                      width: "13px",
                      height: "13px",
                      accentColor: "#22c55e",
                      cursor: "pointer",
                    }}
                  />
                  <span>Remove on send</span>
                </label>
              </div>
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
                Choose a playlist from the left.
              </p>
            )}

            {!loadingTracks && selectedPlaylistId && tracks.length > 0 && (
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
                        {/* Preview button */}
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
                              background: isPlaying ? "#4b5563" : "transparent",
                              color: "#f9fafb",
                              cursor: "pointer",
                            }}
                          >
                            {isPlaying ? "⏹" : "▶"}
                          </button>
                        </td>
                        {/* Title + Album Cover + Artist (clickable for preview) */}
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
                        {/* Destination buttons (3x2 grid) */}
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
                                  slot.mode === "existing" && !!slot.playlistId;
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
                                      cursor: enabled ? "pointer" : "default",
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
                        {/* BPM */}
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
                        {/* Genres */}
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
                        {/* Spotify open button */}
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
                                window.open(
                                  `https://open.spotify.com/track/${t.id}`,
                                  "_blank",
                                  "noopener,noreferrer"
                                );
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
          </div>
        </div>

        {/* BOTTOM: Destinations */}
        <div
          style={{
            marginTop: "0.6rem",
            borderTop: "1px solid #1f2933",
            paddingTop: "0.35rem",
          }}
        >
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
                !!selectedPlaylistId &&
                slot.playlistId === selectedPlaylistId;

              return (
                <div
                  key={slot.id}
                  style={{
                    flex: "1 1 180px",
                    minWidth: "180px",
                    border: "1px solid #1f2933",
                    borderRadius: "0.75rem",
                    padding: "0.7rem 0.75rem 0.35rem",
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
                      borderTopLeftRadius: "0.75rem",
                      borderTopRightRadius: "0.75rem",
                      background: color,
                    }}
                  />

                  <select
                    value={selectValue}
                    onChange={(e) => {
                      handleDestinationSelectChange(slot.id, e.target.value);
                      focusTracks();
                    }}
                    style={{
                      width: "100%",
                      padding: "0.32rem 0.5rem",
                      borderRadius: "0.5rem",
                      border: isSourcePlaylist
                        ? "2px solid #ef4444"
                        : "1px solid #374151",
                      background: "#020617",
                      color: "#e5e7eb",
                      fontSize: "0.8rem",
                      marginBottom: "0.25rem",
                    }}
                  >
                    <option value="">No destination</option>
                    <optgroup label="Owned playlists">
                      {ownedPlaylists.map((pl) => (
                        <option key={pl.id} value={pl.id}>
                          {pl.name}
                        </option>
                      ))}
                    </optgroup>

                    {/* If we created a new playlist this session, but it's not in ownedPlaylists yet,
                        still show it as a selectable option */}
                    {slot.mode === "existing" &&
                      slot.playlistId &&
                      !ownedHasPlaylist && (
                        <option value={slot.playlistId}>
                          {slot.displayName || "(new playlist)"}
                        </option>
                      )}

                    <option value="__new__">New playlist…</option>
                  </select>

                  {isSourcePlaylist && (
                    <div
                      style={{
                        fontSize: "0.75rem",
                        color: "#f87171",
                        marginBottom: "0.25rem",
                      }}
                    >
                      This is the source playlist (send is disabled).
                    </div>
                  )}

                  {slot.mode === "new" && (
                    <div style={{ marginBottom: "0.35rem" }}>
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
                            padding: "0.32rem 0.5rem",
                            borderRadius: "0.5rem",
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
                            padding: "0.25rem 0.5rem",
                            borderRadius: "0.5rem",
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
                      marginTop: "0.15rem",
                    }}
                  >
                    Sent this session: {slot.sentTrackIds.length}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </main>
    </>
  );
}
