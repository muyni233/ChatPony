export interface Announcement {
  id: string;
  title: string;
  body: string;
  status: 'draft' | 'published';
  pinned: boolean;
  revision: number;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  readAt?: string | null;
}

export interface AnnouncementList {
  items: Announcement[];
  total: number;
  page: number;
  pageSize: number;
  unreadCount?: number;
}
