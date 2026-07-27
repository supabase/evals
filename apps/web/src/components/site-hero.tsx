import { PageContainer } from "@/components/page-container"

export function SiteHero() {
  return (
    <header className="border-b border-border">
      <div className="w-full pt-24 pb-20 sm:pb-24 md:pb-28 lg:pb-28">
        <PageContainer className="flex flex-col gap-10 md:gap-12 lg:flex-row lg:items-end lg:justify-between lg:gap-16">
          <div className="flex max-w-2xl min-w-0 flex-col gap-8 sm:gap-10">
            <h1 className="font-heading text-4xl font-medium tracking-normal sm:text-5xl sm:leading-none">
              <span className="block text-foreground">Evaluating agents</span>
              <span className="block text-muted-foreground">
                across Supabase
              </span>
            </h1>
          </div>
          <p className="max-w-md text-base leading-6 text-pretty text-muted-foreground lg:flex-none lg:pb-1">
            We evaluate model experiments across the Supabase developer journey,
            from building and deploying to investigating and resolving
            production issues, with real project context.
          </p>
        </PageContainer>
      </div>
    </header>
  )
}
