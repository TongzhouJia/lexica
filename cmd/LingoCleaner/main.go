package main

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"cloud.google.com/go/storage"
	"google.golang.org/api/option"
)

// 你的基础目录，直接写死
const baseDir = "/Users/jiatongzhou/Public/Drop Box/学外语"

// GCS 配置（和 translate_server 保持一致）
const (
	gcsBucket          = "cloud-storage-jtz"
	gcsDailyWordPrefix = "study-english/vocabulary-list/daily_english_word/"
)

// GCS 客户端（全局复用）
var gcsClient *storage.Client

// 记录本次会话中被修改过的 daily_english_word 文件（文件名 → 本地完整路径）
var changedDailyFiles = make(map[string]string)

func main() {
	fmt.Println("========================================")
	fmt.Println("秘···秘书长，外语得学呀，多学一门好，我也想学外语😘")
	fmt.Println("========================================")

	// 初始化 GCS 客户端
	initGCS()

	scanner := bufio.NewScanner(os.Stdin)

	for {
		fmt.Print("\n👉 请输入单词: ")
		if !scanner.Scan() {
			break
		}
		input := scanner.Text()
		input = strings.TrimSpace(input)

		if input == "bye" || input == "" {
			break
		}

		// 处理逗号分隔的单词
		words := strings.Split(input, ",")
		for _, w := range words {
			word := strings.ToLower(strings.TrimSpace(w))
			if word == "" {
				continue
			}
			processWord(word)
		}
		fmt.Println("✅ 当前批次单词处理完毕！")
	}

	// 退出时询问是否同步云端
	if len(changedDailyFiles) > 0 && gcsClient != nil {
		fmt.Println("========================================")
		fmt.Printf("📋 本次共修改了 %d 个云端文件，是否同步到云端？\n", len(changedDailyFiles))
		for name := range changedDailyFiles {
			fmt.Printf("   • %s\n", name)
		}
		fmt.Print("👉 同步到云端？[Y/n] ")
		if scanner.Scan() {
			answer := strings.TrimSpace(scanner.Text())
			if answer == "" || strings.ToLower(answer) == "y" {
				syncToCloud()
			} else {
				fmt.Println("⏭️ 已跳过云端同步")
			}
		}
	}

	fmt.Println("========================================")
	fmt.Println("刚才不是说学外语吗🤡")
	fmt.Println("========================================")

	if gcsClient != nil {
		gcsClient.Close()
	}
}

// initGCS 初始化 GCS 客户端，使用与 translate_server 相同的凭据查找逻辑
func initGCS() {
	credPath := resolveCredentials()
	if credPath == "" {
		fmt.Println("  ⚠️ 未找到 GCS 凭据，云端同步将不可用")
		return
	}

	ctx := context.Background()
	client, err := storage.NewClient(ctx, option.WithCredentialsFile(credPath))
	if err != nil {
		fmt.Printf("  ⚠️ GCS 客户端初始化失败: %v，云端同步将不可用\n", err)
		return
	}
	gcsClient = client
	fmt.Printf("  ☁️ GCS 已连接 (bucket: %s)\n", gcsBucket)
}

// syncToCloud 批量上传所有修改过的文件到云端
func syncToCloud() {
	fmt.Println("☁️ 开始同步...")
	success := 0
	for name, localPath := range changedDailyFiles {
		gcsPath := gcsDailyWordPrefix + name
		if uploadToGCS(localPath, gcsPath) {
			success++
		}
	}
	fmt.Printf("☁️ 同步完成！成功 %d/%d 个文件\n", success, len(changedDailyFiles))
}

// resolveCredentials 查找服务账号凭据文件（和 translate_server 逻辑一致）
func resolveCredentials() string {
	if envPath := strings.TrimSpace(os.Getenv("GOOGLE_APPLICATION_CREDENTIALS")); envPath != "" {
		if abs, err := filepath.Abs(envPath); err == nil {
			return abs
		}
		return envPath
	}

	projectRoot := resolveProjectRoot()

	candidateDirs := []string{
		filepath.Join(projectRoot, "credentials"),
		filepath.Join(projectRoot, "cmd", "translate_server", "credentials"),
		projectRoot,
	}
	for _, dir := range candidateDirs {
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, e := range entries {
			if !e.IsDir() && strings.HasPrefix(e.Name(), "vertex-") && strings.HasSuffix(e.Name(), ".json") {
				return filepath.Join(dir, e.Name())
			}
		}
	}
	return ""
}

// resolveProjectRoot 查找项目根目录
func resolveProjectRoot() string {
	if _, err := os.Stat("../../.env"); err == nil {
		root, _ := filepath.Abs("../../")
		return root
	}
	if _, err := os.Stat(".env"); err == nil {
		root, _ := filepath.Abs(".")
		return root
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "GolandProjects", "my-toolbox")
}

// 处理单个单词的核心逻辑（全部只改本地）
func processWord(word string) {
	fmt.Printf("\n--- 开始处理单词: [%s] ---\n", word)
	firstLetter := string(word[0])

	// 1. 处理 alphabet_order_word 下的 txt 文件
	alphaWordPath := filepath.Join(baseDir, "alphabet_order_word", firstLetter+".txt")
	removeFromTxt(alphaWordPath, word, "alphabet_order_word")

	// 2. 处理 alphabet_order_audio 下的音频（修改为 .bak）
	alphaAudioPath := filepath.Join(baseDir, "alphabet_order_audio", firstLetter, word+".mp3")
	renameAudio(alphaAudioPath, "alphabet_order_audio")

	// 3. 处理 daily_english_word 下的 txt 文件（只改本地，记录变更文件）
	dailyWordDir := filepath.Join(baseDir, "daily_english_word")
	processDailyWords(dailyWordDir, word)

	// 4. 处理 daily_english_audio 下的音频（修改为 .bak）
	dailyAudioDir := filepath.Join(baseDir, "daily_english_audio")
	processDailyAudio(dailyAudioDir, word)
}

// 从 txt 文件中删除包含该单词的行，返回是否找到并删除了
func removeFromTxt(filePath string, targetWord string, moduleName string) bool {
	data, err := os.ReadFile(filePath)
	if err != nil {
		if !os.IsNotExist(err) {
			fmt.Printf("  ⚠️ 读取文件失败 [%s]: %v\n", filePath, err)
		}
		return false
	}

	lines := strings.Split(string(data), "\n")
	var newLines []string
	found := false

	for _, line := range lines {
		fields := strings.Fields(line)
		if !found && len(fields) > 0 && strings.ToLower(fields[0]) == targetWord {
			found = true
			continue
		}
		newLines = append(newLines, line)
	}

	if found {
		err = os.WriteFile(filePath, []byte(strings.Join(newLines, "\n")), 0644)
		if err != nil {
			fmt.Printf("  ❌ 更新文件失败 [%s]: %v\n", filePath, err)
		} else {
			fmt.Printf("  📝 成功从 %s 中删除该单词记录\n", filepath.Base(filePath))
		}
	}
	return found
}

// uploadToGCS 将本地文件上传覆盖云端同路径文件，返回是否成功
func uploadToGCS(localPath string, gcsObjectPath string) bool {
	data, err := os.ReadFile(localPath)
	if err != nil {
		fmt.Printf("  ⚠️ 读取本地文件失败，云端未同步 [%s]: %v\n", localPath, err)
		return false
	}

	ctx := context.Background()
	writer := gcsClient.Bucket(gcsBucket).Object(gcsObjectPath).NewWriter(ctx)
	writer.ContentType = "text/plain; charset=utf-8"
	if _, err := writer.Write(data); err != nil {
		writer.Close()
		fmt.Printf("  ❌ 上传失败 [%s]: %v\n", filepath.Base(gcsObjectPath), err)
		return false
	}
	if err := writer.Close(); err != nil {
		fmt.Printf("  ❌ 上传失败 [%s]: %v\n", filepath.Base(gcsObjectPath), err)
		return false
	}

	fmt.Printf("  ☁️ %s ✓\n", filepath.Base(gcsObjectPath))
	return true
}

// 将 mp3 后缀改为 mp3.bak
func renameAudio(filePath string, moduleName string) {
	if _, err := os.Stat(filePath); err == nil {
		newPath := filePath + ".bak"
		err := os.Rename(filePath, newPath)
		if err != nil {
			fmt.Printf("  ❌ 隐藏音频失败 [%s]: %v\n", moduleName, err)
		} else {
			fmt.Printf("  🎵 成功隐藏音频 [%s]: %s\n", moduleName, filepath.Base(newPath))
		}
	}
}

// 遍历 daily_english_word 寻找并删除单词（仅本地），记录变更文件
// 每个单词只会出现在一个 day 文件中，找到即停止
func processDailyWords(dir string, targetWord string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".txt") {
			filePath := filepath.Join(dir, entry.Name())
			if removeFromTxt(filePath, targetWord, "daily_english_word") {
				// 记录这个文件被改过，退出时统一同步
				changedDailyFiles[entry.Name()] = filePath
				return
			}
		}
	}
}

// 遍历 daily_english_audio 寻找并隐藏音频（仅本地）
// 每个单词只会有一个音频，找到即停止
func processDailyAudio(dir string, targetWord string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if entry.IsDir() && strings.HasPrefix(entry.Name(), "day") {
			audioPath := filepath.Join(dir, entry.Name(), targetWord+".mp3")
			if _, err := os.Stat(audioPath); err == nil {
				renameAudio(audioPath, "daily_english_audio")
				return
			}
		}
	}
}
