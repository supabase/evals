import { useEffect, useRef, useState } from "react"
import { CheckIcon, CopyIcon } from "lucide-react"

import { PageContainer } from "@/components/page-container"
import { Button } from "@/components/ui/button"
import { track } from "@/lib/analytics"
import { CLI_COMMAND, DOCS_URL, WEBSITE_URL } from "@/lib/links"

const COPY_FEEDBACK_MS = 2000

function SupabaseLogo() {
  return (
    <svg
      className="h-6 w-auto"
      viewBox="0 0 109 113"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="Supabase"
      role="img"
    >
      <path
        d="M63.7076 110.284C60.8481 113.885 55.0502 111.912 54.9813 107.314L53.9738 40.0627L99.1935 40.0627C107.384 40.0627 111.952 49.5228 106.859 55.9374L63.7076 110.284Z"
        fill="url(#supabase-logo-paint0)"
      />
      <path
        d="M63.7076 110.284C60.8481 113.885 55.0502 111.912 54.9813 107.314L53.9738 40.0627L99.1935 40.0627C107.384 40.0627 111.952 49.5228 106.859 55.9374L63.7076 110.284Z"
        fill="url(#supabase-logo-paint1)"
        fillOpacity="0.2"
      />
      <path
        d="M45.317 2.07103C48.1765 -1.53037 53.9745 0.442937 54.0434 5.041L54.4849 72.2922H9.83113C1.64038 72.2922 -2.92775 62.8321 2.1655 56.4175L45.317 2.07103Z"
        fill="#3ECF8E"
      />
      <defs>
        <linearGradient
          id="supabase-logo-paint0"
          x1="53.9738"
          y1="54.974"
          x2="94.1635"
          y2="71.8295"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#249361" />
          <stop offset="1" stopColor="#3ECF8E" />
        </linearGradient>
        <linearGradient
          id="supabase-logo-paint1"
          x1="36.1558"
          y1="30.578"
          x2="54.4844"
          y2="65.0806"
          gradientUnits="userSpaceOnUse"
        >
          <stop />
          <stop offset="1" stopOpacity="0" />
        </linearGradient>
      </defs>
    </svg>
  )
}

function CopyCommandButton() {
  const [copied, setCopied] = useState(false)
  const resetTimeoutRef = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (resetTimeoutRef.current !== null) {
        window.clearTimeout(resetTimeoutRef.current)
      }
    }
  }, [])

  const copyCommand = () => {
    void navigator.clipboard.writeText(CLI_COMMAND)
    track("evals_cli_command_copied")
    setCopied(true)

    if (resetTimeoutRef.current !== null) {
      window.clearTimeout(resetTimeoutRef.current)
    }

    resetTimeoutRef.current = window.setTimeout(() => {
      setCopied(false)
      resetTimeoutRef.current = null
    }, COPY_FEEDBACK_MS)
  }

  return (
    <Button
      variant="secondary"
      className="justify-between gap-4 font-mono text-xs text-muted-foreground hover:text-foreground"
      onClick={copyCommand}
      aria-label={copied ? "Copied" : `Copy ${CLI_COMMAND}`}
    >
      <span className="truncate">{CLI_COMMAND}</span>
      {copied ? (
        <CheckIcon className="size-3.5 shrink-0" aria-hidden />
      ) : (
        <CopyIcon className="size-3.5 shrink-0" aria-hidden />
      )}
    </Button>
  )
}

export function SiteHeader() {
  return (
    <div className="sticky top-0 z-50 border-b border-dotted bg-background">
      <PageContainer className="flex items-center justify-between py-3">
        <a
          href={WEBSITE_URL}
          className="group/logo flex w-fit items-center gap-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <SupabaseLogo />
          <span className="-translate-x-2 text-sm text-muted-foreground opacity-0 transition-all duration-200 group-hover/logo:translate-x-0 group-hover/logo:opacity-100 group-focus-visible/logo:translate-x-0 group-focus-visible/logo:opacity-100">
            Back to Supabase
          </span>
        </a>
        <div className="hidden items-center gap-2 sm:flex">
          <CopyCommandButton />
          <Button variant="secondary" asChild>
            <a
              href={DOCS_URL}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => track("evals_ai_tools_clicked")}
            >
              AI Tools
            </a>
          </Button>
        </div>
      </PageContainer>
    </div>
  )
}
