import apiClient from './client'

export interface CreatePaperQARunRequest {
  input: {
    question: string
    paper_id?: string
    top_k?: number
  }
  context?: {
    paper_id?: string
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
  getEvents: (runId: string) => apiClient.get(`/agent-runs/${runId}/events`),
}
