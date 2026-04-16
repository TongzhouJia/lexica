package main

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// 你的基础目录，直接写死
const baseDir = "/Users/jiatongzhou/Public/Drop Box/学外语"

func main() {
	fmt.Println("========================================")
	fmt.Println("秘···秘书长，外语得学呀，多学一门好，我也想学外语😘")
	fmt.Println("========================================")

	scanner := bufio.NewScanner(os.Stdin)

	for {
		fmt.Print("\n👉 请输入单词: ")
		if !scanner.Scan() {
			break
		}
		input := scanner.Text()
		input = strings.TrimSpace(input)

		if input == "bye" || input == "" {
			fmt.Println("========================================")
			fmt.Println("刚才不是说学外语吗🤡")
			fmt.Println("========================================")
			break
		}

		if input == "" {
			continue
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
}

// 处理单个单词的核心逻辑
func processWord(word string) {
	fmt.Printf("\n--- 开始处理单词: [%s] ---\n", word)
	firstLetter := string(word[0])

	// 1. 处理 alphabet_order_word 下的 txt 文件
	alphaWordPath := filepath.Join(baseDir, "alphabet_order_word", firstLetter+".txt")
	removeFromTxt(alphaWordPath, word, "alphabet_order_word")

	// 2. 处理 alphabet_order_audio 下的音频 (修改为 .bak)
	alphaAudioPath := filepath.Join(baseDir, "alphabet_order_audio", firstLetter, word+".mp3")
	renameAudio(alphaAudioPath, "alphabet_order_audio")

	// 3. 处理 daily_english_word 下的 txt 文件
	dailyWordDir := filepath.Join(baseDir, "daily_english_word")
	processDailyWords(dailyWordDir, word)

	// 4. 处理 daily_english_audio 下的音频 (修改为 .bak)
	dailyAudioDir := filepath.Join(baseDir, "daily_english_audio")
	processDailyAudio(dailyAudioDir, word)
}

// 从 txt 文件中删除包含该单词的行
func removeFromTxt(filePath string, targetWord string, moduleName string) {
	data, err := os.ReadFile(filePath)
	if err != nil {
		if !os.IsNotExist(err) {
			fmt.Printf("  ⚠️ 读取文件失败 [%s]: %v\n", filePath, err)
		}
		return
	}

	lines := strings.Split(string(data), "\n")
	var newLines []string
	modified := false

	for _, line := range lines {
		// 用空格/Tab分割，提取第一个词组进行精准比对
		fields := strings.Fields(line)
		if len(fields) > 0 && strings.ToLower(fields[0]) == targetWord {
			modified = true
			continue // 匹配到了，跳过该行（相当于删除）
		}
		newLines = append(newLines, line)
	}

	if modified {
		// 覆盖写回文件
		err = os.WriteFile(filePath, []byte(strings.Join(newLines, "\n")), 0644)
		if err != nil {
			fmt.Printf("  ❌ 更新文件失败 [%s]: %v\n", filePath, err)
		} else {
			fmt.Printf("  📝 成功从 %s 中删除该单词记录\n", filepath.Base(filePath))
		}
	}
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

// 遍历 daily_english_word 的所有 txt 文件寻找并删除单词
func processDailyWords(dir string, targetWord string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".txt") {
			filePath := filepath.Join(dir, entry.Name())
			removeFromTxt(filePath, targetWord, "daily_english_word")
		}
	}
}

// 遍历 daily_english_audio 的所有目录寻找并隐藏音频
func processDailyAudio(dir string, targetWord string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if entry.IsDir() && strings.HasPrefix(entry.Name(), "day") { // 筛选 day01, day02 等目录
			audioPath := filepath.Join(dir, entry.Name(), targetWord+".mp3")
			renameAudio(audioPath, "daily_english_audio")
		}
	}
}
