package main

import (
	"bufio"
	"fmt"
	"math/rand"
	"os"
	"strings"
	"time"
)

// Word 结构体用来存储单个单词的信息
type Word struct {
	English string
	Chinese string
}

func main() {
	reader := bufio.NewReader(os.Stdin)
	fmt.Print("请输入单词文件路径 : ")
	filePath, _ := reader.ReadString('\n')

	// 1. 处理文件路径：去除换行符、首尾空格，以及 macOS 拖拽产生的首尾单引号
	filePath = strings.TrimSpace(filePath)
	filePath = strings.Trim(filePath, "'")
	filePath = strings.TrimSpace(filePath) // 再次去除可能残余的空格

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

	earlyExit := false // 提前退出标志

	// 4. 听写循环
	for i, w := range words {
		fmt.Printf("\n[%d/%d] 中文: %s\n", i+1, len(words), w.Chinese)

		isFirstTry := true
		errorCount := 0

		for {
			// 根据错误次数改变提示语
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
				break // 跳出当前单词的无限循环
			}

			// 判断单词是否正确
			if strings.EqualFold(ans, w.English) {
				fmt.Println("✅ 回答正确！")
				if isFirstTry {
					correctWords = append(correctWords, w)
				}
				break // 回答正确，跳出循环，进入下一个单词
			} else {
				// 如果是第一次错，记录到错词本
				if isFirstTry {
					incorrectWords = append(incorrectWords, w)
					isFirstTry = false
				}
				errorCount++

				// 根据错误次数给出不同的反馈
				if errorCount == 1 {
					fmt.Println("❌ 回答错误，请重试。")
				} else if errorCount == 2 {
					fmt.Println("❌ 又错啦！")
				}
			}
		}

		// 如果检测到提前退出标志，跳出外层听写大循环
		if earlyExit {
			break
		}
	}

	// 5. 总结输出
	// 因为可能会提前退出，所以实际练习的数量是正确和错误单词数量之和
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

	if len(incorrectWords) > 0 {
		fmt.Println("【需要重点复习的单词】(拼错过的):")
		for _, w := range incorrectWords {
			fmt.Printf("- %-15s : %s\n", w.English, w.Chinese)
		}
	} else {
		fmt.Println("🎉 太棒了！今天听写的单词都是一次性拼写正确的！")
	}
}
