import { HeadContent, Scripts, createRootRoute } from '@tanstack/react-router'
import appCss from '../styles.css?url'

const FAVICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='16' fill='%230e1a33'/%3E%3Crect x='12.5' y='7' width='7' height='12' rx='3.5' fill='%2322d3ee'/%3E%3Cpath d='M9.5 16a6.5 6.5 0 0 0 13 0M16 22.5V26' stroke='%2322d3ee' stroke-width='2' fill='none' stroke-linecap='round'/%3E%3C/svg%3E"

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1, viewport-fit=cover' },
      { name: 'color-scheme', content: 'dark' },
      { name: 'theme-color', content: '#05060a' },
      { title: 'Voice chat' },
      { name: 'description', content: 'Hold a button, talk, hear a spoken reply.' },
    ],
    links: [
      { rel: 'stylesheet', href: appCss },
      { rel: 'icon', href: FAVICON },
    ],
  }),
  shellComponent: ({ children }) => (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body className="h-dvh text-zinc-100 antialiased">
        {children}
        <Scripts />
      </body>
    </html>
  ),
})
