import { Component, type ReactNode } from 'react';

/**
 * The last line of defence: an error while rendering would otherwise leave a blank page.
 * Work is saved as it goes, so reloading is safe.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error) {
    console.error(error);
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="crash" role="alert">
        <p className="crash-title">Something went wrong</p>
        <p>Your plan is saved as you go. Reloading opens it again.</p>
        <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}
