import type { ClientContext } from './types';

export type View = 'chats' | 'mia' | 'people' | 'settings' | 'drafts';
const routes: Record<View, string> = { chats: '/chats', mia: '/mia', people: '/contacts', settings: '/settings', drafts: '/drafts' };
export function viewRoute(view: View, chatId: string | null = null) {
  return view === 'chats' && chatId ? `/chat/${chatId}` : routes[view];
}
export function sameContext(left: ClientContext | null, right: ClientContext | null) {
  return left?.route === right?.route && left?.revision === right?.revision && left?.previousRoute === right?.previousRoute;
}
export class NavigationContext {
  private current: ClientContext = { route: '/chats', revision: 0 };
  snapshot(): ClientContext { return { ...this.current }; }
  move(route: string) {
    if (route !== this.current.route) this.current = { route, revision: this.current.revision + 1, previousRoute: this.current.route };
    return this.snapshot();
  }
  reset() { this.current = { route: '/chats', revision: this.current.revision + 1 }; }
}
