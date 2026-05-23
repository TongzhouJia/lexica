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
// Call Google Cloud TTS API  (en-AU-Standard-A, Australian female)
// ---------------------------------------------------------------------------

func synthesizeTTS(apiKey, text string) ([]byte, error) {
	apiURL := "https://texttospeech.googleapis.com/v1/text:synthesize?key=" + apiKey

	req := ttsRequest{}
	req.Input.Text = text
	req.Voice.LanguageCode = "en-AU"
	req.Voice.Name = "en-AU-Standard-A"
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
// playLocal – get or synthesize TTS, play via afplay (non-blocking goroutine)
// ---------------------------------------------------------------------------

func playLocal(ttsKey, text string) {
	go func() {
		// 1. Check disk/memory cache for existing MP3 file
		if cachedPath, ok := ttsCache.Load(text); ok {
			mp3Path := cachedPath.(string)
			if _, err := os.Stat(mp3Path); err == nil {
				log.Printf("[tts disk hit] %s", text)
				exec.Command("afplay", mp3Path).Run()
				return
			}
		}

		// 2. Call TTS API
		audioBytes, err := synthesizeTTS(ttsKey, text)
		if err != nil {
			log.Printf("[tts error] %v", err)
			return
		}

		// 3. Save to disk cache
		mp3Path := saveTTSAudio(text, audioBytes)
		if mp3Path != "" {
			ttsCache.Store(text, mp3Path)
			log.Printf("[tts cached] %s → %s", text, mp3Path)
			exec.Command("afplay", mp3Path).Run()
		}
	}()
}

// ---------------------------------------------------------------------------
// Play handler – GET /play?text=hello → triggers local afplay
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
