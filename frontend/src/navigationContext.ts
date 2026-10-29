import type { ClientContext } from './types';

export type View = 'assistant' | 'chats' | 'people' | 'settings' | 'drafts';
const routes: Record<View, string> = { assistant: '/mia', chats: '/chats', people: '/contacts', settings: '/settings', drafts: '/drafts' };
export function pageView(route: unknown): View | null {
  return (Object.keys(routes) as View[]).find(view => routes[view] === route) ?? null;
}
export function viewRoute(view: View, chatId: string | null = null) {
  return view === 'chats' && chatId ? `/chat/${chatId}` : routes[view];
}
export function routeView(route: string): { view: View; chatId: string | null } {
  if (route.startsWith('/chat/')) return { view: 'chats', chatId: route.slice('/chat/'.length) };
  return { view: pageView(route) ?? 'chats', chatId: null };
}
export function sameContext(left: ClientContext | null, right: ClientContext | null) {
  return left?.route === right?.route && left?.revision === right?.revision && left?.previousRoute === right?.previousRoute;
}
export class NavigationContext {
  private current: ClientContext = { route: '/chats', revision: 0 };
  private history: string[] = [];
  snapshot(): ClientContext { return { ...this.current }; }
  move(route: string) {
    if (route !== this.current.route) {
      if (route.startsWith('/chat/')) this.history.push(this.current.route);
      else this.history = [];
      this.current = { route, revision: this.current.revision + 1, previousRoute: this.current.route };
    }
    return this.snapshot();
  }
  back() {
    const route = this.history.pop() ?? '/chats';
    if (route !== this.current.route) this.current = { route, revision: this.current.revision + 1, previousRoute: this.current.route };
    return this.snapshot();
  }
  reset() { this.history = []; this.current = { route: '/chats', revision: this.current.revision + 1 }; }
}
