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
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
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
// Google Translate API v2 response
// ---------------------------------------------------------------------------

type translateResponse struct {
	Data struct {
		Translations []struct {
			TranslatedText string `json:"translatedText"`
		} `json:"translations"`
	} `json:"data"`
}

// ---------------------------------------------------------------------------
// Load .env (no third-party deps)
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
// Resolve project root
// ---------------------------------------------------------------------------

func resolveProjectRoot() string {
	candidates := []string{"../../.env", "../.env", ".env"}
	for _, c := range candidates {
		if _, err := os.Stat(c); err == nil {
			abs, _ := filepath.Abs(filepath.Dir(c))
			return abs
		}
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "GolandProjects", "my-toolbox")
}

// ---------------------------------------------------------------------------
// TTS disk cache — shared with gsay & translate_server
// Location: data/tts_cache/<hash>.mp3 + index.json
// ---------------------------------------------------------------------------

func textHash(text string) string {
	h := sha256.Sum256([]byte(text))
	return fmt.Sprintf("%x", h)[:16]
}

func lookupTTSCache(cacheDir, text string) string {
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

func saveTTSCache(cacheDir, text string, audioBytes []byte) string {
	os.MkdirAll(cacheDir, 0755)

	filename := textHash(text) + ".mp3"
	mp3Path := filepath.Join(cacheDir, filename)

	if err := os.WriteFile(mp3Path, audioBytes, 0644); err != nil {
		fmt.Fprintf(os.Stderr, "⚠️  TTS 缓存写入失败: %v\n", err)
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
// Translate cache — shared with translate_server
// Location: data/translate_server/cache.json
// Format: { "en:zh:hello": "你好", ... }
// ---------------------------------------------------------------------------

var translateCacheMu sync.Mutex

func loadTranslateCache(cachePath string) map[string]string {
	data, err := os.ReadFile(cachePath)
	if err != nil {
		return make(map[string]string)
	}
	var m map[string]string
	if err := json.Unmarshal(data, &m); err != nil {
		return make(map[string]string)
	}
	return m
}

func saveTranslateCacheEntry(cachePath, key, value string) {
	translateCacheMu.Lock()
	defer translateCacheMu.Unlock()

	m := loadTranslateCache(cachePath)
	m[key] = value

	dir := filepath.Dir(cachePath)
	os.MkdirAll(dir, 0755)
	if data, err := json.MarshalIndent(m, "", "  "); err == nil {
		os.WriteFile(cachePath, data, 0644)
	}
}

// ---------------------------------------------------------------------------
// Google Translate API v2
// ---------------------------------------------------------------------------

func translateWord(apiKey, text string) (string, error) {
	endpoint := "https://translation.googleapis.com/language/translate/v2"

	params := url.Values{}
	params.Set("key", apiKey)
	params.Set("q", text)
	params.Set("source", "en")
	params.Set("target", "zh-CN")
	params.Set("format", "text")

	resp, err := http.Get(endpoint + "?" + params.Encode())
	if err != nil {
		return "", fmt.Errorf("网络请求失败: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("读取响应失败: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("API 错误 %d: %s", resp.StatusCode, string(body))
	}

	var result translateResponse
	if err := json.Unmarshal(body, &result); err != nil {
		return "", fmt.Errorf("JSON 解析失败: %w", err)
	}

	if len(result.Data.Translations) == 0 {
		return "", fmt.Errorf("未返回翻译结果")
	}

	return result.Data.Translations[0].TranslatedText, nil
}

// ---------------------------------------------------------------------------
// Get translation (cache-aware)
// ---------------------------------------------------------------------------

func getTranslation(translateKey, text, translateCachePath string) string {
	// Match translate_server cache key format: "en:zh-CN:text"
	cacheKey := "en:zh-CN:" + text

	// Check cache (try both zh-CN and zh for compatibility)
	m := loadTranslateCache(translateCachePath)
	if cached, ok := m[cacheKey]; ok {
		return cached
	}
	if cached, ok := m["en:zh:"+text]; ok {
		return cached
	}

	// Call API
	translated, err := translateWord(translateKey, text)
	if err != nil {
		return fmt.Sprintf("(翻译失败: %v)", err)
	}

	// Save to shared cache
	saveTranslateCacheEntry(translateCachePath, cacheKey, translated)
	return translated
}

// ---------------------------------------------------------------------------
// Google TTS synthesis (async, with shared cache)
// ---------------------------------------------------------------------------

func googleSynthesizeAsync(apiKey, text, cacheDir string) {
	go func() {
		// Check disk cache first
		if mp3Path := lookupTTSCache(cacheDir, text); mp3Path != "" {
			exec.Command("afplay", mp3Path).Run()
			return
		}

		apiURL := "https://texttospeech.googleapis.com/v1/text:synthesize?key=" + apiKey

		req := ttsRequest{}
		req.Input.Text = text
		req.Voice.LanguageCode = "en-AU"
		req.Voice.Name = "en-AU-Standard-A"
		req.AudioConfig.AudioEncoding = "MP3"

		jsonData, err := json.Marshal(req)
		if err != nil {
			fmt.Fprintf(os.Stderr, "⚠️  TTS JSON 编码失败: %v\n", err)
			return
		}

		resp, err := http.Post(apiURL, "application/json", bytes.NewReader(jsonData))
		if err != nil {
			fmt.Fprintf(os.Stderr, "⚠️  TTS 网络请求失败: %v\n", err)
			return
		}
		defer resp.Body.Close()

		body, err := io.ReadAll(resp.Body)
		if err != nil {
			fmt.Fprintf(os.Stderr, "⚠️  TTS 读取响应失败: %v\n", err)
			return
		}

		var ttsResp ttsResponse
		if err := json.Unmarshal(body, &ttsResp); err != nil {
			fmt.Fprintf(os.Stderr, "⚠️  TTS 解析响应失败: %v\n", err)
			return
		}
		if ttsResp.Error != nil {
			fmt.Fprintf(os.Stderr, "⚠️  TTS API 报错: %s\n", ttsResp.Error.Message)
			return
		}

		audioBytes, err := base64.StdEncoding.DecodeString(ttsResp.AudioContent)
		if err != nil {
			fmt.Fprintf(os.Stderr, "⚠️  TTS Base64 解码失败: %v\n", err)
			return
		}

		// Save to shared cache, then play
		mp3Path := saveTTSCache(cacheDir, text, audioBytes)
		if mp3Path == "" {
			tmp, err := os.CreateTemp("", "word_reader-*.mp3")
			if err != nil {
				return
			}
			defer os.Remove(tmp.Name())
			tmp.Write(audioBytes)
			tmp.Close()
			mp3Path = tmp.Name()
		}

		exec.Command("afplay", mp3Path).Run()
	}()
}

// ---------------------------------------------------------------------------
// Local say command (async)
// ---------------------------------------------------------------------------

func localSayAsync(text string) {
	go func() {
		exec.Command("say", "-v", "Karen (Premium)", text).Run()
	}()
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

func main() {
	projectRoot := resolveProjectRoot()
	loadEnv(filepath.Join(projectRoot, ".env"))

	// Shared cache paths (same as gsay & translate_server)
	ttsCacheDir := filepath.Join(projectRoot, "data", "tts_cache")
	translateCachePath := filepath.Join(projectRoot, "data", "translate_server", "cache.json")

	fmt.Println("===========================================")
	fmt.Println("       📖 Word Reader - 单词朗读器")
	fmt.Println("===========================================")
	fmt.Println()
	fmt.Println("  请选择语音合成方式:")
	fmt.Println()
	fmt.Println("  1. 本地语音 (macOS say - Karen Premium 澳洲口音)")
	fmt.Println("  2. Google TTS (en-AU-Standard-A 澳洲口音)")
	fmt.Println()

	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)

	var mode int
	for {
		fmt.Print("👉 请输入选项 (1 或 2): ")
		if !scanner.Scan() {
			return
		}
		choice := strings.TrimSpace(scanner.Text())
		if choice == "1" {
			mode = 1
			break
		} else if choice == "2" {
			mode = 2
			break
		}
		fmt.Println("⚠️  无效选项，请输入 1 或 2")
	}

	// Validate API keys
	translateKey := os.Getenv("GOOGLE_TRANSLATE_API_KEY")
	if translateKey == "" {
		fmt.Fprintln(os.Stderr, "❌ 错误: 未找到 GOOGLE_TRANSLATE_API_KEY，请检查 .env 文件")
		os.Exit(1)
	}

	var ttsAPIKey string
	if mode == 2 {
		ttsAPIKey = os.Getenv("GOOGLE_TTS_API_KEY")
		if ttsAPIKey == "" {
			fmt.Fprintln(os.Stderr, "❌ 错误: 未找到 GOOGLE_TTS_API_KEY，请检查 .env 文件")
			os.Exit(1)
		}
	}

	modeName := "本地 say (Karen Premium)"
	if mode == 2 {
		modeName = "Google TTS (en-AU-Standard-A)"
	}
	fmt.Printf("\n✅ 已选择: %s\n", modeName)
	fmt.Println("输入单词后按回车即可朗读并翻译，输入 quit 或 exit 退出。")
	fmt.Println("-------------------------------------------")

	for {
		fmt.Print("\n📝 请输入单词: ")
		if !scanner.Scan() {
			break
		}
		text := strings.TrimSpace(scanner.Text())
		if text == "" {
			continue
		}
		if text == "quit" || text == "exit" {
			fmt.Println("👋 再见！")
			break
		}

		// 1. Kick off audio playback in background (non-blocking)
		switch mode {
		case 1:
			localSayAsync(text)
		case 2:
			googleSynthesizeAsync(ttsAPIKey, text, ttsCacheDir)
		}

		// 2. Show translation (this runs while audio plays)
		translated := getTranslation(translateKey, text, translateCachePath)
		fmt.Printf("🔤 %s → %s\n", text, translated)
	}
}
