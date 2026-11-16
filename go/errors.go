package zuno

import (
	"fmt"
)

// HarnessError 是 SDK 的错误类型，带稳定的 Code。
// 调用方按原因分支，而不是按消息文本。
type HarnessError struct {
	Code    string
	Message string
	// Cause 是底层系统错误（如有）。
	Cause error
}

func (e *HarnessError) Error() string {
	if e.Cause != nil {
		return fmt.Sprintf("%s: %s: %v", e.Code, e.Message, e.Cause)
	}
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

func (e *HarnessError) Unwrap() error { return e.Cause }

func newError(code, message string) *HarnessError {
	return &HarnessError{Code: code, Message: message}
}

func wrapError(code, message string, cause error) *HarnessError {
	return &HarnessError{Code: code, Message: message, Cause: cause}
}

// 协议/传输层错误码。与 TypeScript SDK 的 HarnessError 保持一致。
const (
	CodeTimeout              = "timeout"
	CodeDisconnected         = "disconnected"
	CodeConnectFailed        = "connect_failed"
	CodeHandshakeFailed      = "handshake_failed"
	CodeUnexpectedReply      = "unexpected_reply"
	CodeFrameTooLarge        = "frame_too_large"
	CodeInvalidOption        = "invalid_option"
	CodeUnsupported          = "unsupported"
	CodeUnsupportedTransport = "unsupported_transport"
	CodeBusy                 = "busy"
	// 运行时也可能以任意 code 回 error 帧，直接透传它的 code。
)
