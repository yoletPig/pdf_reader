import apiClient from './client'

export interface AgentRunEvent {
  sequence: number
  type: string
  payload: Record<string, any>
  created_at: string
}

export interface AgentRunEventsResponse {
  run_id: string
  events: AgentRunEvent[]
}

export interface CreatePaperQARunRequest {
  input: {
    question: string
    paper_id?: string
    top_k?: number
  }
  context?: {
    paper_id?: string
    session_id?: string
    current_page?: number
    selected_text?: string
  }
}

export const agentRunsApi = {
  createPaperQA: (data: CreatePaperQARunRequest) =>
    apiClient.post('/agent-runs', {
      agent: 'paper_qa',
      input: data.input,
      context: data.context ?? {},
    }),
  getEvents: (runId: string) => apiClient.get<AgentRunEventsResponse>(`/agent-runs/${runId}/events`),
}
