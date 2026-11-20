package zuno

import "encoding/json"

// FilesystemPolicy 指定只读绝对目录。nil 策略继承，空 ReadRoots 拒绝全部。
// 不支持写目录，所有配置均为只读。
type FilesystemPolicy struct {
	ReadRoots []string `json:"read_roots"`
}

// MarshalJSON 保证零值策略发送 []，而不是有歧义的 null。
func (p FilesystemPolicy) MarshalJSON() ([]byte, error) {
	roots := p.ReadRoots
	if roots == nil {
		roots = []string{}
	}
	return json.Marshal(struct {
		ReadRoots []string `json:"read_roots"`
	}{ReadRoots: roots})
}
