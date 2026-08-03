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
      { label: 'Contacts', to: '/app/contacts', icon: '◎' },
      { label: 'Leads', to: '/app/leads', icon: '◎' },
      { label: 'Campaign', to: '/app/scraper', icon: '⌁' },
    ],
  },
  {
    heading: 'Engage',
    items: [
      { label: 'Inbox', to: '/app/inbox', icon: '✉', badge: 'inbox' },
      { label: 'WhatsApp', to: '/app/whatsapp', icon: '◉' },
      { label: 'Email', to: '/app/email', icon: '@' },
      { label: 'SMS', to: '/app/sms', icon: '✆' },
    ],
  },
  {
    heading: 'AI Agent',
    items: [
      { label: 'WhatsApp Brain', to: '/app/ai/whatsapp-brain', icon: '◉' },
      { label: 'Email Brain', to: '/app/ai/email-brain', icon: '@' },
      { label: 'SMS Brain', to: '/app/ai/sms-brain', icon: '✆' },
    ],
  },
  {
    heading: 'Automate',
    items: [
      { label: 'Automations', to: '/app/automations', icon: '⚙' },
      { label: 'Reports', to: '/app/reports', icon: '▦' },
    ],
  },
];

export const FOOTER_ITEMS: NavItem[] = [
  { label: 'Settings', to: '/app/settings', icon: '⚙' },
  { label: 'Subscription', to: '/app/settings/subscription', icon: '♕' },
  { label: 'Account', to: '/app/account', icon: '◕' },
];
