package main

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
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
// Load .env
// ---------------------------------------------------------------------------

func loadEnv(path string) {
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		parts := strings.SplitN(line, "=", 2)
		if len(parts) != 2 {
			continue
		}
		key := strings.TrimSpace(parts[0])
		val := strings.TrimSpace(parts[1])
		val = strings.Trim(val, `"'`)
		os.Setenv(key, val)
	}
}

// ---------------------------------------------------------------------------
// TTS disk cache (shared with translate_server)
// Location: data/tts_cache/<hash>.mp3 + index.json
// ---------------------------------------------------------------------------

func textHash(text string) string {
	h := sha256.Sum256([]byte(text))
	return fmt.Sprintf("%x", h)[:16]
}

// lookupCache checks if an MP3 already exists on disk for this text
func lookupCache(cacheDir, text string) string {
	indexPath := filepath.Join(cacheDir, "index.json")
	data, err := os.ReadFile(indexPath)
	if err != nil {
		return ""
	}
	var m map[string]string
	if err := json.Unmarshal(data, &m); err != nil {
		return ""
	}
	filename, ok := m[text]
	if !ok {
		return ""
	}
	mp3Path := filepath.Join(cacheDir, filename)
	if _, err := os.Stat(mp3Path); err != nil {
		return ""
	}
	return mp3Path
}

// saveCache writes the MP3 to disk and updates index.json
func saveCache(cacheDir, text string, audioBytes []byte) string {
	os.MkdirAll(cacheDir, 0755)

	filename := textHash(text) + ".mp3"
	mp3Path := filepath.Join(cacheDir, filename)

	if err := os.WriteFile(mp3Path, audioBytes, 0644); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: cache write failed: %v\n", err)
		return ""
	}

	// Update index.json
	indexPath := filepath.Join(cacheDir, "index.json")
	m := make(map[string]string)
	if data, err := os.ReadFile(indexPath); err == nil {
		json.Unmarshal(data, &m)
	}
	m[text] = filename
	if data, err := json.MarshalIndent(m, "", "  "); err == nil {
		os.WriteFile(indexPath, data, 0644)
	}

	return mp3Path
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintf(os.Stderr, "Usage: gsay <word or sentence>\n")
		fmt.Fprintf(os.Stderr, "  gsay hello\n")
		fmt.Fprintf(os.Stderr, "  gsay \"good morning\"\n")
		os.Exit(1)
	}

	// Join all args as the text (supports both `gsay hello` and `gsay "hello world"`)
	text := strings.Join(os.Args[1:], " ")

	// Resolve project root
	var projectRoot string
	if _, err := os.Stat("../../.env"); err == nil {
		projectRoot, _ = filepath.Abs("../../")
	} else {
		home, _ := os.UserHomeDir()
		projectRoot = filepath.Join(home, "GolandProjects", "my-toolbox")
	}

	// Load .env
	loadEnv(filepath.Join(projectRoot, ".env"))

	apiKey := os.Getenv("GOOGLE_TTS_API_KEY")
	if apiKey == "" {
		fmt.Fprintln(os.Stderr, "Error: GOOGLE_TTS_API_KEY not set in .env")
		os.Exit(1)
	}

	// Shared TTS cache directory: data/tts_cache/
	cacheDir := filepath.Join(projectRoot, "data", "tts_cache")

	// Check disk cache first
	if mp3Path := lookupCache(cacheDir, text); mp3Path != "" {
		fmt.Printf("🔊 %s (cached)\n", text)
		cmd := exec.Command("afplay", mp3Path)
		if err := cmd.Run(); err != nil {
			fmt.Fprintf(os.Stderr, "Error playing audio: %v\n", err)
			os.Exit(1)
		}
		return
	}

	// Call Google TTS API
	apiURL := "https://texttospeech.googleapis.com/v1/text:synthesize?key=" + apiKey

	req := ttsRequest{}
	req.Input.Text = text
	req.Voice.LanguageCode = "en-AU"
	req.Voice.Name = "en-AU-Standard-A"
	req.AudioConfig.AudioEncoding = "MP3"

	jsonData, err := json.Marshal(req)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	resp, err := http.Post(apiURL, "application/json", bytes.NewReader(jsonData))
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	var ttsResp ttsResponse
	if err := json.Unmarshal(body, &ttsResp); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
	if ttsResp.Error != nil {
		fmt.Fprintf(os.Stderr, "API error: %s\n", ttsResp.Error.Message)
		os.Exit(1)
	}

	audioBytes, err := base64.StdEncoding.DecodeString(ttsResp.AudioContent)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	// Save to disk cache, then play from cached file
	mp3Path := saveCache(cacheDir, text, audioBytes)
	if mp3Path == "" {
		// fallback: temp file
		tmp, err := os.CreateTemp("", "gsay-*.mp3")
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
		defer os.Remove(tmp.Name())
		tmp.Write(audioBytes)
		tmp.Close()
		mp3Path = tmp.Name()
	}

	fmt.Printf("🔊 %s\n", text)
	cmd := exec.Command("afplay", mp3Path)
	if err := cmd.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "Error playing audio: %v\n", err)
		os.Exit(1)
	}
}
