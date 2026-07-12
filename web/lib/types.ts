export interface ApiResponse<T = unknown> {
  data?: T;
  error?: string;
}

export interface Session {
  id: string;
  username: string;
  expires_at: string;
  created_at: string;
}
