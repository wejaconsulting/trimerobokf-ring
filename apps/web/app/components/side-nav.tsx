'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export interface NavItem {
  readonly href: string;
  readonly label: string;
  readonly count?: number | null;
  /** Marks the item active for this path and everything below it. */
  readonly exact?: boolean;
}

export function SideNav({ items }: { items: readonly NavItem[] }) {
  const pathname = usePathname();

  return (
    <nav aria-label="Huvudnavigering" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {items.map((item) => {
        const active = item.exact ? pathname === item.href : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            className="side-link"
            {...(active ? { 'aria-current': 'page' as const } : {})}
          >
            {item.label}
            {typeof item.count === 'number' ? <span className="count">{item.count}</span> : null}
          </Link>
        );
      })}
    </nav>
  );
}
