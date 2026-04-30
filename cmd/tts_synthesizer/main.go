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

// TTSRequest 定义请求谷歌 TTS 接口的 JSON 结构
type TTSRequest struct {
	Input struct {
		Text string `json:"text"`
	} `json:"input"`
	Voice struct {
		LanguageCode string `json:"languageCode"`
		Name         string `json:"name"`
	} `json:"voice"`
	AudioConfig struct {
		AudioEncoding string  `json:"audioEncoding"`
		SpeakingRate  float64 `json:"speakingRate"`
	} `json:"audioConfig"`
}

// TTSResponse 定义接收谷歌响应的 JSON 结构
type TTSResponse struct {
	AudioContent string `json:"audioContent"`
	Error        *struct {
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

// CacheEntry 用于记录缓存文件和原文的对应关系
type CacheEntry struct {
	Text     string `json:"text"`
	Hash     string `json:"hash"`
	FilePath string `json:"filePath"`
}

// CacheIndex 缓存索引，方便查找已合成的文本
type CacheIndex struct {
	Entries []CacheEntry `json:"entries"`
}

func main() {
	// 手动读取 .env 文件
	workDir, _ := os.Getwd()
	envPath := filepath.Join(workDir, ".env")
	loadEnv(envPath)

	// 从环境变量读取 API 密钥
	apiKey := os.Getenv("GOOGLE_TTS_API_KEY")
	if apiKey == "" {
		fmt.Println("❌ 错误: 未找到 GOOGLE_TTS_API_KEY！")
		fmt.Println("请在项目根目录创建 .env 文件，并写入：\nGOOGLE_TTS_API_KEY=\"你的密钥\"")
		return
	}

	// 数据目录：data/tts_synthesizer
	toolDataDir := filepath.Join(workDir, "data", "tts_synthesizer")
	if err := os.MkdirAll(toolDataDir, os.ModePerm); err != nil {
		fmt.Printf("❌ 创建数据文件夹失败: %v\n", err)
		return
	}

	// 缓存索引文件路径
	indexPath := filepath.Join(toolDataDir, "cache_index.json")

	// 加载缓存索引
	cacheIndex := loadCacheIndex(indexPath)

	// 构建文本->缓存条目的查找 map
	cacheMap := buildCacheMap(cacheIndex)

	apiUrl := "https://texttospeech.googleapis.com/v1/text:synthesize?key=" + apiKey

	fmt.Println("🎙️  语音合成器已就绪！")
	fmt.Println("输入一段文字后回车即可合成并播放语音。")
	fmt.Println("输入 'quit' 或 'exit' 退出程序。")
	fmt.Println("-------------------------------------------")

	scanner := bufio.NewScanner(os.Stdin)
	// 增大 scanner 缓冲区以支持较长文本
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)

	for {
		fmt.Print("\n📝 请输入文本: ")
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

		// 计算文本的 SHA256 哈希作为缓存标识
		hash := computeHash(text)

		// 检查缓存
		if entry, found := cacheMap[hash]; found {
			// 验证缓存文件确实存在
			if _, err := os.Stat(entry.FilePath); err == nil {
				fmt.Printf("💾 命中缓存！直接播放...\n")
				playAudio(entry.FilePath)
				continue
			}
			// 缓存记录在但文件不在了，需要重新合成
			fmt.Println("⚠️  缓存记录存在但音频文件丢失，重新合成中...")
		}

		// 没有缓存，调用 API 合成
		fmt.Println("🔄 正在调用 Google TTS 合成语音...")

		audioBytes, err := synthesize(apiUrl, text)
		if err != nil {
			fmt.Printf("❌ 合成失败: %v\n", err)
			continue
		}

		// 保存音频文件，文件名使用哈希值
		audioPath := filepath.Join(toolDataDir, hash+".mp3")
		if err := os.WriteFile(audioPath, audioBytes, 0644); err != nil {
			fmt.Printf("❌ 保存音频失败: %v\n", err)
			continue
		}

		// 更新缓存索引
		newEntry := CacheEntry{
			Text:     text,
			Hash:     hash,
			FilePath: audioPath,
		}
		cacheIndex.Entries = append(cacheIndex.Entries, newEntry)
		cacheMap[hash] = newEntry
		saveCacheIndex(indexPath, cacheIndex)

		fmt.Println("✅ 合成成功！正在播放...")
		playAudio(audioPath)
	}
}

// synthesize 调用 Google TTS API 合成语音，返回音频字节
func synthesize(apiUrl, text string) ([]byte, error) {
	// 自动检测语言：如果包含中文字符则使用中文语音，否则使用英文
	langCode, voiceName := detectLanguage(text)

	reqData := TTSRequest{}
	reqData.Input.Text = text
	reqData.Voice.LanguageCode = langCode
	reqData.Voice.Name = voiceName
	reqData.AudioConfig.AudioEncoding = "MP3"
	reqData.AudioConfig.SpeakingRate = 1.0

	jsonData, err := json.Marshal(reqData)
	if err != nil {
		return nil, fmt.Errorf("JSON 编码失败: %v", err)
	}

	resp, err := http.Post(apiUrl, "application/json", bytes.NewBuffer(jsonData))
	if err != nil {
		return nil, fmt.Errorf("网络请求失败: %v", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("读取响应失败: %v", err)
	}

	var ttsResp TTSResponse
	if err := json.Unmarshal(body, &ttsResp); err != nil {
		return nil, fmt.Errorf("解析响应失败: %v", err)
	}

	if ttsResp.Error != nil {
		return nil, fmt.Errorf("API 报错: %s", ttsResp.Error.Message)
	}

	audioBytes, err := base64.StdEncoding.DecodeString(ttsResp.AudioContent)
	if err != nil {
		return nil, fmt.Errorf("Base64 解码失败: %v", err)
	}

	return audioBytes, nil
}

// detectLanguage 简单的语言检测：包含中文字符则认为是中文
func detectLanguage(text string) (langCode, voiceName string) {
	for _, r := range text {
		if r >= '\u4e00' && r <= '\u9fff' {
			// 包含中文字符 → 用中文语音
			return "cmn-CN", "cmn-CN-Wavenet-C"
		}
	}
	// 默认英文（澳洲口音，与 tts_downloader 一致）
	return "en-AU", "en-AU-Neural2-C"
}

// computeHash 计算文本的 SHA256 哈希，取前 16 个字符作为文件名
func computeHash(text string) string {
	h := sha256.Sum256([]byte(text))
	return fmt.Sprintf("%x", h)[:16]
}

// playAudio 使用 macOS 的 afplay 播放音频文件（同步等待播放完成）
func playAudio(audioPath string) {
	cmd := exec.Command("afplay", audioPath)
	if err := cmd.Run(); err != nil {
		fmt.Printf("⚠️  播放失败: %v\n", err)
	}
}

// loadCacheIndex 从磁盘加载缓存索引
func loadCacheIndex(path string) *CacheIndex {
	data, err := os.ReadFile(path)
	if err != nil {
		return &CacheIndex{}
	}
	var index CacheIndex
	if err := json.Unmarshal(data, &index); err != nil {
		return &CacheIndex{}
	}
	return &index
}

// saveCacheIndex 将缓存索引持久化到磁盘
func saveCacheIndex(path string, index *CacheIndex) {
	data, err := json.MarshalIndent(index, "", "  ")
	if err != nil {
		fmt.Printf("⚠️  保存缓存索引失败: %v\n", err)
		return
	}
	if err := os.WriteFile(path, data, 0644); err != nil {
		fmt.Printf("⚠️  写入缓存索引失败: %v\n", err)
	}
}

// buildCacheMap 将缓存索引构建为 hash → CacheEntry 的查找 map
func buildCacheMap(index *CacheIndex) map[string]CacheEntry {
	m := make(map[string]CacheEntry, len(index.Entries))
	for _, e := range index.Entries {
		m[e.Hash] = e
	}
	return m
}

// 简单实现 .env 解析，省去第三方依赖
func loadEnv(filename string) {
	b, err := os.ReadFile(filename)
	if err != nil {
		return
	}
	lines := strings.Split(string(b), "\n")
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if len(line) == 0 || strings.HasPrefix(line, "#") {
			continue
		}
		parts := strings.SplitN(line, "=", 2)
		if len(parts) == 2 {
			key := strings.TrimSpace(parts[0])
			val := strings.TrimSpace(parts[1])
			val = strings.Trim(val, `"'`)
			os.Setenv(key, val)
		}
	}
}
