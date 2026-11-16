package zuno

import (
	"encoding/json"
	"sort"
	"strings"

	jsons "github.com/santhosh-tekuri/jsonschema/v6"
	"golang.org/x/text/language"
	"golang.org/x/text/message"
)

// schemaName 是编译 JSON Schema 时的资源名，仅用于错误信息。
const schemaName = "schema.json"

// validationPrinter 是校验消息的本地化打印器（英文，稳定输出）。
var validationPrinter = message.NewPrinter(language.English)

// compileSchema 把可 JSON 序列化的 schema 编译为校验器。
func compileSchema(schema any) (*jsons.Schema, error) {
	data, err := json.Marshal(schema)
	if err != nil {
		return nil, wrapError("structured_schema_invalid", "schema 无法序列化", err)
	}
	doc, err := jsons.UnmarshalJSON(strings.NewReader(string(data)))
	if err != nil {
		return nil, wrapError("structured_schema_invalid", "schema 不是合法 JSON", err)
	}
	compiler := jsons.NewCompiler()
	if err := compiler.AddResource(schemaName, doc); err != nil {
		return nil, wrapError("structured_schema_invalid", "schema 无法注册", err)
	}
	compiled, err := compiler.Compile(schemaName)
	if err != nil {
		return nil, newError("structured_schema_invalid", err.Error())
	}
	return compiled, nil
}

// validateValue 用编译好的 schema 校验一个已解码的 JSON 值。
// 返回归一化的问题列表；为空表示通过。
func validateValue(schema *jsons.Schema, value any) []ValidationIssue {
	err := schema.Validate(value)
	if err == nil {
		return nil
	}
	var verr *jsons.ValidationError
	if !asValidation(err, &verr) {
		return []ValidationIssue{{Path: "/", Keyword: "schema", Message: err.Error()}}
	}
	return normalizeValidation(verr)
}

func asValidation(err error, target **jsons.ValidationError) bool {
	if verr, ok := err.(*jsons.ValidationError); ok {
		*target = verr
		return true
	}
	return false
}

func normalizeValidation(verr *jsons.ValidationError) []ValidationIssue {
	issues := []ValidationIssue{validationIssueOf(verr)}
	for _, cause := range verr.Causes {
		issues = append(issues, normalizeValidation(cause)...)
	}
	return issues
}

func validationIssueOf(verr *jsons.ValidationError) ValidationIssue {
	path := "/"
	if len(verr.InstanceLocation) > 0 {
		path = "/" + strings.Join(verr.InstanceLocation, "/")
	}
	keyword := ""
	messageText := ""
	if verr.ErrorKind != nil {
		if kwPath := verr.ErrorKind.KeywordPath(); len(kwPath) > 0 {
			keyword = kwPath[len(kwPath)-1]
		}
		messageText = verr.ErrorKind.LocalizedString(validationPrinter)
	} else {
		messageText = "未通过 schema 校验"
	}
	return ValidationIssue{
		Path:    path,
		Keyword: keyword,
		Message: messageText,
	}
}

// FormatIssue 渲染一条校验问题，用于纠正提示词。
func FormatIssue(issue ValidationIssue) string {
	path := issue.Path
	if path == "" {
		path = "/"
	}
	return path + " " + issue.Message
}

// sortedSchemaJSON 输出键序稳定的 schema JSON，供提示词使用。
func sortedSchemaJSON(value any) string {
	data, err := json.Marshal(sortJSONValue(value))
	if err != nil {
		return "null"
	}
	return string(data)
}

func sortJSONValue(value any) any {
	switch v := value.(type) {
	case map[string]any:
		keys := make([]string, 0, len(v))
		for k := range v {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		out := make(map[string]any, len(v))
		for _, k := range keys {
			out[k] = sortJSONValue(v[k])
		}
		// 保持键序：通过 json.Marshal 无法保留，改用有序编码。
		return sortedMap{keys: keys, values: out}
	case []any:
		for i := range v {
			v[i] = sortJSONValue(v[i])
		}
		return v
	default:
		return value
	}
}

// sortedMap 是保持插入序的 JSON 编码适配。
type sortedMap struct {
	keys   []string
	values map[string]any
}

func (m sortedMap) MarshalJSON() ([]byte, error) {
	var buf strings.Builder
	buf.WriteByte('{')
	for i, k := range m.keys {
		if i > 0 {
			buf.WriteByte(',')
		}
		keyJSON, err := json.Marshal(k)
		if err != nil {
			return nil, err
		}
		buf.Write(keyJSON)
		buf.WriteByte(':')
		valueJSON, err := json.Marshal(m.values[k])
		if err != nil {
			return nil, err
		}
		buf.Write(valueJSON)
	}
	buf.WriteByte('}')
	return []byte(buf.String()), nil
}
