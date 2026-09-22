import { signInAction } from "@/lib/actions";

export const dynamic = "force-dynamic";

export default function SignedOutPage() {
  return (
    <div className="card">
      <h3>Signed out</h3>
      <p className="muted">Your session has ended on this browser.</p>
      <form action={signInAction}>
        <button type="submit">Sign in</button>
      </form>
    </div>
  );
}
