package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"strings"
)

// ---------------------------------------------------------------------------
// Google Cloud TTS API structures
// ---------------------------------------------------------------------------

type ttsRequest struct {
	Input struct {
		Text string `json:"text"`
	} `json:"input"`
	Voice struct {
		LanguageCode string `json:"languageCode"`
		Name         string `json:"name"`
	} `json:"voice"`
	AudioConfig struct {
		AudioEncoding string `json:"audioEncoding"`
	} `json:"audioConfig"`
}

type ttsResponse struct {
	AudioContent string `json:"audioContent"`
	Error        *struct {
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

// ---------------------------------------------------------------------------
// Voice selection.
//
// English is the default and stays exactly as it was (en-AU-Standard-A,
// Australian female) — callers that pass an empty lang get the old behavior
// byte for byte. "ja" was added for the Japanese 专业词 tiers, which ship
// without pre-recorded mp3s and so need synthesis.
// ---------------------------------------------------------------------------

type ttsVoice struct {
	Code string
	Name string
}

func ttsVoiceFor(lang string) ttsVoice {
	switch lang {
	case "ja", "ja-JP":
		return ttsVoice{Code: "ja-JP", Name: "ja-JP-Standard-A"}
	default:
		return ttsVoice{Code: "en-AU", Name: "en-AU-Standard-A"}
	}
}

// ttsCacheKey namespaces non-English audio so a Japanese clip can't collide
// with an English one for the same text. English keeps the bare text as its
// key, which keeps every already-cached English mp3 valid.
func ttsCacheKey(lang, text string) string {
	if v := ttsVoiceFor(lang); v.Code != "en-AU" {
		return v.Code + ":" + text
	}
	return text
}

// ---------------------------------------------------------------------------
// Call Google Cloud TTS API
// ---------------------------------------------------------------------------

func synthesizeTTS(apiKey, text, lang string) ([]byte, error) {
	apiURL := "https://texttospeech.googleapis.com/v1/text:synthesize?key=" + apiKey

	voice := ttsVoiceFor(lang)
	req := ttsRequest{}
	req.Input.Text = text
	req.Voice.LanguageCode = voice.Code
	req.Voice.Name = voice.Name
	req.AudioConfig.AudioEncoding = "MP3"

	jsonData, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("JSON encode failed: %w", err)
	}

	resp, err := http.Post(apiURL, "application/json", bytes.NewReader(jsonData))
	if err != nil {
		return nil, fmt.Errorf("TTS request failed: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read TTS body failed: %w", err)
	}

	var ttsResp ttsResponse
	if err := json.Unmarshal(body, &ttsResp); err != nil {
		return nil, fmt.Errorf("TTS JSON decode failed: %w", err)
	}
	if ttsResp.Error != nil {
		return nil, fmt.Errorf("TTS API error: %s", ttsResp.Error.Message)
	}

	audioBytes, err := base64.StdEncoding.DecodeString(ttsResp.AudioContent)
	if err != nil {
		return nil, fmt.Errorf("base64 decode failed: %w", err)
	}

	return audioBytes, nil
}

// ---------------------------------------------------------------------------
// localPlayer – resolve a command-line audio player for the host.
// Was hardcoded to macOS `afplay`; on Linux we prefer mpv, then ffplay.
// Override with AUDIO_PLAYER=<binary> (the file path is appended as the only arg).
// ---------------------------------------------------------------------------

func localPlayer(mp3Path string) *exec.Cmd {
	if bin := strings.TrimSpace(os.Getenv("AUDIO_PLAYER")); bin != "" {
		return exec.Command(bin, mp3Path)
	}
	if bin, err := exec.LookPath("mpv"); err == nil {
		return exec.Command(bin, "--no-video", "--really-quiet", mp3Path)
	}
	if bin, err := exec.LookPath("ffplay"); err == nil {
		return exec.Command(bin, "-nodisp", "-autoexit", "-loglevel", "error", mp3Path)
	}
	if bin, err := exec.LookPath("afplay"); err == nil { // macOS fallback
		return exec.Command(bin, mp3Path)
	}
	return nil
}

func playFile(mp3Path string) {
	cmd := localPlayer(mp3Path)
	if cmd == nil {
		log.Printf("[tts error] no audio player found (install ffplay or mpv, or set AUDIO_PLAYER)")
		return
	}
	if err := cmd.Run(); err != nil {
		log.Printf("[tts play error] %v", err)
	}
}

// ---------------------------------------------------------------------------
// playLocal – get or synthesize TTS, play locally (non-blocking goroutine)
// ---------------------------------------------------------------------------

func playLocal(ttsKey, text string) {
	go func() {
		// 1. Check disk/memory cache for existing MP3 file
		if cachedPath, ok := ttsCache.Load(text); ok {
			mp3Path := cachedPath.(string)
			if _, err := os.Stat(mp3Path); err == nil {
				log.Printf("[tts disk hit] %s", text)
				playFile(mp3Path)
				return
			}
		}

		// 2. Call TTS API
		audioBytes, err := synthesizeTTS(ttsKey, text, "")
		if err != nil {
			log.Printf("[tts error] %v", err)
			return
		}

		// 3. Save to disk cache
		mp3Path := saveTTSAudio(text, audioBytes)
		if mp3Path != "" {
			ttsCache.Store(text, mp3Path)
			log.Printf("[tts cached] %s → %s", text, mp3Path)
			playFile(mp3Path)
		}
	}()
}

// ---------------------------------------------------------------------------
// Play handler – GET /play?text=hello → triggers local playback
// ---------------------------------------------------------------------------

func playHandler(ttsKey string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		text := r.URL.Query().Get("text")
		if text == "" {
			http.Error(w, "missing text", http.StatusBadRequest)
			return
		}
		playLocal(ttsKey, text)
		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, "ok")
	}
}
