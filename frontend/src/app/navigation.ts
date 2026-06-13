// Sidebar navigation model (S3). Grouped to signal the product story:
// capture -> engage -> automate -> configure.

export interface NavItem {
  label: string;
  to: string;
  icon: string;
  badge?: 'inbox';
}

export interface NavGroup {
  heading: string;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    heading: 'Overview',
    items: [{ label: 'Dashboard', to: '/app', icon: '◧' }],
  },
  {
    heading: 'Capture',
    items: [
      { label: 'Leads', to: '/app/leads', icon: '◎' },
      { label: 'Scraper', to: '/app/scraper', icon: '⌕' },
    ],
  },
  {
    heading: 'Engage',
    items: [
      { label: 'Inbox', to: '/app/inbox', icon: '✉', badge: 'inbox' },
      { label: 'WhatsApp', to: '/app/whatsapp', icon: '◉' },
      { label: 'Email', to: '/app/email', icon: '@' },
      { label: 'AI Agent', to: '/app/ai-agent', icon: '✦' },
    ],
  },
  {
    heading: 'Automate',
    items: [{ label: 'Automations', to: '/app/automations', icon: '⚙' }],
  },
];

export const FOOTER_ITEMS: NavItem[] = [
  { label: 'Workspace (Classic)', to: '/app/workspace', icon: '▤' },
  { label: 'Settings', to: '/app/settings', icon: '⚙' },
];
