use serde::Serialize;

#[derive(Debug, Clone)]
pub struct HelperError {
    pub code: &'static str,
    pub message: String,
}

impl HelperError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn invalid_args(msg: impl Into<String>) -> Self {
        Self::new("INVALID_ARGS", msg)
    }

    pub fn invalid_input(msg: impl Into<String>) -> Self {
        Self::new("INVALID_INPUT", msg)
    }

    pub fn not_found(msg: impl Into<String>) -> Self {
        Self::new("NOT_FOUND", msg)
    }

    pub fn win32(api: &str, err_code: u32) -> Self {
        Self::new("WIN32_ERROR", format!("{api} failed (error {err_code})"))
    }
}

#[derive(Serialize)]
pub struct ErrorResponse<'a> {
    pub ok: bool,
    pub code: &'a str,
    pub error: &'a str,
}

impl HelperError {
    pub fn to_json_line(&self) -> String {
        let resp = ErrorResponse {
            ok: false,
            code: self.code,
            error: &self.message,
        };
        serde_json::to_string(&resp)
            .unwrap_or_else(|_| r#"{"ok":false,"code":"SERIALIZE_ERROR","error":"failed to serialize error"}"#.to_string())
    }
}
