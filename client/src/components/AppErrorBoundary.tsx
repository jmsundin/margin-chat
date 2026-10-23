import { Component, type ErrorInfo, type ReactNode } from "react";
import "./AppErrorBoundary.css";

interface State { error: Error | null; copied: boolean }

/**
 * Catches a render error anywhere in the app, so a crash shows a way out instead of a blank
 * page. Documents are saved as they are typed, so reloading loses nothing already saved.
 */
export default class AppErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null, copied: false };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Margin Chat crashed", error, info.componentStack);
  }

  private details() {
    const { error } = this.state;
    return [`${error?.name ?? "Error"}: ${error?.message ?? ""}`, error?.stack ?? "", `Page: ${window.location.href}`,
      `Version: ${import.meta.env.VITE_APP_COMMIT ?? "development"}`, `Browser: ${navigator.userAgent}`].join("\n");
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="app-error" role="alert">
        <div className="app-error-card">
          <h1>Something went wrong</h1>
          <p>Margin Chat hit an error and stopped drawing this page. Your documents are saved as you type, so reloading is safe.</p>
          <div className="app-error-actions">
            <button type="button" className="app-error-primary" onClick={() => window.location.reload()}>Reload</button>
            <button type="button" onClick={() => {
              void navigator.clipboard?.writeText(this.details()).then(() => this.setState({ copied: true }), () => undefined);
            }}>{this.state.copied ? "Copied" : "Copy error details"}</button>
          </div>
          <details>
            <summary>Error details</summary>
            <pre>{this.details()}</pre>
          </details>
        </div>
      </div>
    );
  }
}
