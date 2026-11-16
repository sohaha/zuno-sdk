package zuno

import (
	"bytes"
	"encoding/json"
	"fmt"
)

// maxFrameBytes 是残余缓冲的上限。一行协议帧不应超过这个量级；
// 没有上限的话，永不换行的对端会让内存无界增长。
const maxFrameBytes = 8 * 1024 * 1024

// ndjsonDecoder 在字节流上做换行分隔的增量 JSON 解码。
//
// socket 可能在任意位置切开帧，所以按 chunk 解码是错的；这里维护一个
// 残余缓冲，只在行完整时才产出。空行会被跳过，与 Rust 端读取器一致。
type ndjsonDecoder struct {
	buf []byte
}

// push 送入一段新数据，返回完整行的原始字节切片。
func (d *ndjsonDecoder) push(chunk []byte) ([][]byte, error) {
	d.buf = append(d.buf, chunk...)
	if len(d.buf) > maxFrameBytes && !bytes.ContainsRune(d.buf, '\n') {
		d.buf = d.buf[:0]
		return nil, newError(CodeFrameTooLarge, fmt.Sprintf("单帧超过 %d 字节上限", maxFrameBytes))
	}
	var out [][]byte
	for {
		index := bytes.IndexByte(d.buf, '\n')
		if index < 0 {
			return out, nil
		}
		line := bytes.TrimSpace(d.buf[:index])
		d.buf = d.buf[index+1:]
		if len(line) > 0 {
			out = append(out, append([]byte(nil), line...))
		}
	}
}

// encodeFrame 把一帧序列化为带换行的 NDJSON 行。
func encodeFrame(frame any) ([]byte, error) {
	data, err := json.Marshal(frame)
	if err != nil {
		return nil, wrapError("encode_failed", "帧序列化失败", err)
	}
	return append(data, '\n'), nil
}
