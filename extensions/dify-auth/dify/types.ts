export type DifyPayload = {
  inputs: Record<string, unknown>;
  query: string;
  response_mode: string;
  conversation_id: string;
  user: string;
  files: Array<{
    type: string;
    transfer_method: string;
    url?: string;
    upload_file_id?: string;
  }>;
  tool_call_mode?: string;
  tools?: Array<{
    type: string;
    function: { name: string; description?: string; parameters: unknown };
  }>;
  tool_choice?: unknown;
  tool_results?: Array<{ tool_call_id: string; output: string; is_error?: boolean }>;
};

export type DifyResponseEvent = {
  event: string;
  answer?: string;
  thought?: string;
  message?: string;
  task_id?: string;
  conversation_id?: string;
  tool?: string;
  tool_input?: string;
  tool_call_id?: string;
  id?: string;
  name?: string;
  arguments?: string;
  tool_calls?: unknown;
  toolCalls?: unknown;
};
