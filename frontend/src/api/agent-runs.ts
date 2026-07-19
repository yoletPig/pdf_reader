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

export interface RetrievalScoreBreakdown {
  vector_score: number
  lexical_score: number
  bridge_score: number
  section_bonus: number
  clue_bonus: number
  final_score: number
}

export interface RetrievalDebugResult {
  paper_id: string
  paper_title: string
  page: number
  chunk_id: string
  section_title: string
  chunk_text: string
  relevance_score: number
  score_breakdown: RetrievalScoreBreakdown
}

export interface RetrievalDebugResponse {
  question: string
  paper_id?: string
  top_k: number
  candidate_count: number
  used_fallback: boolean
  results: RetrievalDebugResult[]
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
  getRetrieveDebug: (data: { question: string; paper_id?: string; top_k?: number }) =>
    apiClient.post<RetrievalDebugResponse>('/agent-runs/retrieve-debug', {
      question: data.question,
      paper_id: data.paper_id,
      top_k: data.top_k ?? 5,
    }),
}
