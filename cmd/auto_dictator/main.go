package main

import (
	"bufio"
	"fmt"
	"math/rand"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// Word 结构体用来存储单个单词的信息
type Word struct {
	English string
	Chinese string
}

// playAudio 负责自动查找并调用 macOS 自带的 afplay 命令播放音频
func playAudio(word string) {
	// 固定的根目录
	baseAudioDir := "/Users/jiatongzhou/Public/Drop Box/学外语/daily_english_audio"

	// 使用通配符 * 来匹配 day01 ~ day21 等所有子目录
	pattern := filepath.Join(baseAudioDir, "*", word+".mp3")
	matches, err := filepath.Glob(pattern)

	// 如果没找到匹配的音频，或者发生了错误，直接静默退出
	if err != nil || len(matches) == 0 {
		return
	}

	// 找到了，直接拿匹配到的第一个文件路径去播放
	audioPath := matches[0]
	cmd := exec.Command("afplay", audioPath)

	// 异步执行，放它的音频，你继续下一个词
	go cmd.Run()
}

func main() {
	reader := bufio.NewReader(os.Stdin)
	fmt.Print("请输入单词文件路径 (可以直接将文件拖入终端): ")
	filePath, _ := reader.ReadString('\n')

	// 1. 处理文件路径
	filePath = strings.TrimSpace(filePath)
	filePath = strings.Trim(filePath, "'")
	filePath = strings.TrimSpace(filePath)

	// 2. 读取文件内容
	file, err := os.Open(filePath)
	if err != nil {
		fmt.Printf("打开文件失败，请检查路径是否正确: %v\n", err)
		return
	}
	defer file.Close()

	var words []Word
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}

		fields := strings.Fields(line)
		if len(fields) >= 2 {
			words = append(words, Word{
				English: fields[0],
				Chinese: strings.Join(fields[1:], " "),
			})
		}
	}

	if len(words) == 0 {
		fmt.Println("文件中没有找到单词或格式不正确。")
		return
	}

	// 3. 打乱单词顺序
	r := rand.New(rand.NewSource(time.Now().UnixNano()))
	r.Shuffle(len(words), func(i, j int) {
		words[i], words[j] = words[j], words[i]
	})

	var correctWords []Word
	var incorrectWords []Word

	inputScanner := bufio.NewScanner(os.Stdin)

	fmt.Printf("\n========== 开始听写 ==========\n")
	fmt.Printf("本次共加载了 %d 个单词。(随时输入 'bye' 可提前结束并总结)\n", len(words))

	earlyExit := false

	// 4. 听写循环
	for i, w := range words {
		fmt.Printf("\n[%d/%d] 中文: %s\n", i+1, len(words), w.Chinese)

		isFirstTry := true
		errorCount := 0

		for {
			if errorCount >= 2 {
				fmt.Printf("👉 正确答案是: %s (请照打一遍以继续): ", w.English)
			} else {
				fmt.Print("请输入英文: ")
			}

			if !inputScanner.Scan() {
				return
			}
			ans := strings.TrimSpace(inputScanner.Text())

			// 检查是否输入了提前结束的关键字
			if strings.ToLower(ans) == "bye" {
				fmt.Println("\n👋 收到“bye”，提前结束当前听写！")
				earlyExit = true
				break
			}

			// 判断单词是否正确
			if strings.EqualFold(ans, w.English) {
				fmt.Println("✅ 回答正确！🎵 正在查找并播放发音...")
				fmt.Println("---------------------------------")
				fmt.Printf("👉 %s : ", w.English)
				fmt.Println(w.Chinese)
				fmt.Println("---------------------------------")
				fmt.Printf("👉 %s : ", w.English)
				fmt.Println(w.Chinese)
				fmt.Println("---------------------------------")
				fmt.Printf("👉 %s : ", w.English)
				fmt.Println(w.Chinese)
				fmt.Println("---------------------------------")
				fmt.Printf("👉 %s : ", w.English)
				fmt.Println(w.Chinese)
				fmt.Println("---------------------------------")
				fmt.Printf("👉 %s : ", w.English)
				fmt.Println(w.Chinese)
				fmt.Println("---------------------------------")

				playAudio(w.English)

				if isFirstTry {
					correctWords = append(correctWords, w)
				}
				break
			} else {
				if isFirstTry {
					incorrectWords = append(incorrectWords, w)
					isFirstTry = false
				}
				errorCount++

				if errorCount == 1 {
					fmt.Println("❌ 回答错误，请重试。")
				} else if errorCount == 2 {
					fmt.Println("❌ 又错啦！")
				}
			}
		}

		if earlyExit {
			break
		}
	}

	// 5. 总结输出
	practicedCount := len(correctWords) + len(incorrectWords)

	fmt.Println("\n========== 听写总结 ==========")
	if practicedCount == 0 {
		fmt.Println("你还没有完成任何一个单词的听写哦。")
		return
	}

	fmt.Printf("本次实际听写: %d 个单词\n", practicedCount)
	fmt.Printf("一次拼对: %d 个\n", len(correctWords))
	fmt.Printf("曾经拼错: %d 个\n", len(incorrectWords))
	fmt.Println("------------------------------")

	// 新增：打印一次性拼对的单词
	if len(correctWords) > 0 {
		fmt.Println("🌟【一次拼对的单词】(超棒的):")
		for _, w := range correctWords {
			fmt.Printf("- %-15s : %s\n", w.English, w.Chinese)
		}
		fmt.Println("------------------------------")
	}

	// 打印拼错的单词
	if len(incorrectWords) > 0 {
		fmt.Println("⚠️【需要重点复习的单词】(拼错过的):")
		for _, w := range incorrectWords {
			fmt.Printf("- %-15s : %s\n", w.English, w.Chinese)
		}
	} else {
		fmt.Println("🎉 太强了！今天听写的单词没有任何错题，完美通关！")
	}
}
