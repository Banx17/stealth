import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { KeyRound, Lock, User, AlertCircle, CheckCircle2, X } from "lucide-react";
import { cn } from "@/lib/utils";

export interface AuthModalProps {
  open: boolean;
  onClose: () => void;
  onSuccess: (userData: { userId: string; username: string; email: string }) => void;
}

export function AuthModal({ open, onClose, onSuccess }: AuthModalProps) {
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!identifier.trim() || !password) {
      setError("Please enter your email/username and password.");
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/v1/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier, password }),
      });

      const data = await res.json();

      if (!res.ok) {
        if (res.status === 429) {
          setError("Too many failed login attempts. Please try again later.");
        } else if (res.status === 403) {
          if (data.error?.code === "unverified_account") {
            setError("Your account is pending verification. Please verify your email.");
          } else if (data.error?.code === "account_suspended") {
            setError("Your account has been suspended. Please contact support.");
          } else if (data.error?.code === "account_deactivated") {
            setError("Your account is deactivated.");
          } else {
            setError(data.error?.message || "Access forbidden.");
          }
        } else {
          setError(data.error?.message || "Invalid email/username or password.");
        }
        setLoading(false);
        return;
      }

      setSuccess(true);
      setTimeout(() => {
        setLoading(false);
        setSuccess(false);
        onSuccess(data.data.user);
        onClose();
      }, 600);
    } catch (err: unknown) {
      setError("Unable to connect to login server. Please try again.");
      setLoading(false);
    }
  };

  if (!open) return null;

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-[120] flex items-center justify-center p-4">
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
          className="fixed inset-0 bg-black/60 backdrop-blur-md"
        />
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 10 }}
          className="relative z-[130] w-full max-w-md overflow-hidden rounded-2xl border border-white/10 bg-[#121316] p-6 text-foreground shadow-2xl"
        >
          <button
            onClick={onClose}
            className="absolute right-4 top-4 rounded-lg p-1 text-muted-foreground transition hover:bg-white/10 hover:text-foreground"
          >
            <X className="h-5 w-5" />
          </button>

          <div className="mb-6 flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <KeyRound className="h-6 w-6" />
            </div>
            <div>
              <h2 className="text-xl font-bold tracking-tight">Sign in to Stealth</h2>
              <p className="text-xs text-muted-foreground">
                Enter your credentials to access your mailbox securely.
              </p>
            </div>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <motion.div
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                className="flex items-center gap-2.5 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive"
              >
                <AlertCircle className="h-4 w-4 shrink-0" />
                <span>{error}</span>
              </motion.div>
            )}

            {success && (
              <motion.div
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                className="flex items-center gap-2.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-400"
              >
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                <span>Authentication successful! Accessing mailbox...</span>
              </motion.div>
            )}

            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                Email or Username
              </label>
              <div className="relative flex items-center">
                <User className="absolute left-3 h-4 w-4 text-muted-foreground" />
                <input
                  type="text"
                  value={identifier}
                  onChange={(e) => setIdentifier(e.target.value)}
                  placeholder="alice@stealth.mail or alice_99"
                  className="glow-ring w-full rounded-lg border border-white/10 bg-white/[0.04] py-2.5 pl-9 pr-3 text-sm text-foreground placeholder:text-muted-foreground/60 transition focus:bg-white/[0.08]"
                  autoComplete="username"
                  required
                />
              </div>
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                Password
              </label>
              <div className="relative flex items-center">
                <Lock className="absolute left-3 h-4 w-4 text-muted-foreground" />
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••••••"
                  className="glow-ring w-full rounded-lg border border-white/10 bg-white/[0.04] py-2.5 pl-9 pr-3 text-sm text-foreground placeholder:text-muted-foreground/60 transition focus:bg-white/[0.08]"
                  autoComplete="current-password"
                  required
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="glow-ring flex w-full items-center justify-center gap-2 rounded-lg bg-primary py-2.5 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90 disabled:opacity-50"
            >
              {loading ? (
                <span className="inline-flex items-center gap-2">
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-primary-foreground border-t-transparent" />
                  Authenticating...
                </span>
              ) : (
                "Sign In"
              )}
            </button>
          </form>
        </motion.div>
      </div>
    </AnimatePresence>
  );
}
