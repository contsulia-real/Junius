import { useMemo } from 'react'
import { ThemeProvider, createThemeFromColorSeed } from '@contsulia/weave'
import { AppBar } from '@contsulia/weave/components/AppBar'
import { Card } from '@contsulia/weave/components/Card'
import { Column } from '@contsulia/weave/components/Column'
import { Grid } from '@contsulia/weave/components/Grid'
import { Image } from '@contsulia/weave/components/Image'
import { Link } from '@contsulia/weave/components/Link'
import { Row } from '@contsulia/weave/components/Row'
import { Text } from '@contsulia/weave/components/Text'

const GITHUB_URL = 'https://github.com/contsulia-real/Junius'
const RELEASES_URL = 'https://github.com/contsulia-real/Junius/releases'

const capabilities = [
  ['Files & Workspaces', 'Read, edit, search, and organize real project files through a bounded local Workspace.'],
  ['Processes & Jobs', 'Run commands and keep long-running work alive as persistent Jobs instead of losing state between turns.'],
  ['Git', 'Inspect repositories, review diffs, prepare commits, and carry normal Git workflows from Chat.'],
  ['Browser & Desktop', 'Use browser automation and Windows desktop control when you explicitly authorize those capabilities.'],
  ['Local Agent Skills', 'Let ChatGPT discover and use the Agent Skills already installed on your own machine.'],
  ['Observability', 'See turns, tool calls, Skills, and execution events in the native Junius panel inside ChatGPT.'],
] as const

const steps = [
  ['1', 'ChatGPT decides', 'The reasoning stays in ChatGPT instead of moving into another local agent interface.'],
  ['2', 'Junius executes locally', 'MCP carries the chosen action to the local Windows runtime and its tools.'],
  ['3', 'You keep working in Chat', 'When Work usage is exhausted, the project can continue from Chat instead of stopping.'],
] as const

function CtaLink({
  href,
  text,
  primary = false,
  target,
}: {
  href: string
  text: string
  primary?: boolean
  target?: '_blank'
}) {
  return (
    <Link
      href={href}
      text={text}
      target={target}
      hideUnderline
      hideIcon={!target}
      viewProps={{
        background: primary ? 'primary' : 'surfaceHover',
        color: primary ? 'onPrimary' : 'tertiary',
        border: primary ? 0 : 0.0625,
        borderColor: primary ? undefined : 'outline',
        paddingX: 1.25,
        paddingY: 0.8,
        radius: 'full',
        transition: {
          properties: ['transform', 'background'],
          duration: 'fast',
        },
        hover: {
          translateY: -0.125,
        },
        active: {
          translateY: 0,
          scale: 0.98,
        },
      }}
    />
  )
}

function App() {
  const theme = useMemo(() => createThemeFromColorSeed('#ff4fa3'), [])

  return (
    <ThemeProvider theme={theme} mode="system">
      <Column minHeight="100vh" background="surface" color="tertiary">
        <AppBar
          size="small"
          title={<Text>Junius</Text>}
          leading={
            <Image
              src="/icon.svg"
              alt="Junius logo"
              fit="contain"
              viewProps={{ width: 2, height: 2 }}
            />
          }
          trailing={
            <Link
              href={GITHUB_URL}
              text="GitHub"
              target="_blank"
              hideUnderline
            />
          }
          viewProps={{
            borderBottom: 0.0625,
            borderBottomColor: 'outline',
          }}
        />

        <Column role="main" width="fill">
          <Grid
            columns={1}
            md={{ columns: 2 }}
            gap={4}
            align="center"
            width="fill"
            maxWidth={76}
            marginX="auto"
            paddingX={1.5}
            paddingY={6}
          >
            <Column gap={2} maxWidth={40}>
              <Text
                typo="display-large"
                wrap="balance"
                viewProps={{ maxWidth: 38 }}
              >
                Work runs out. The work doesn&apos;t have to stop.
              </Text>

              <Text
                typo="body-large"
                color="secondary"
                wrap="balance"
                viewProps={{ maxWidth: 36 }}
              >
                Junius keeps ChatGPT Chat connected to your Windows machine
                through MCP, so you can continue working locally after Work
                usage is exhausted.
              </Text>

              <Row gap={1} wrap align="center">
                <CtaLink
                  href={RELEASES_URL}
                  text="Get Junius"
                  target="_blank"
                  primary
                />
                <CtaLink
                  href="#how-it-works"
                  text="How it works"
                />
              </Row>

              <Text typo="body-small" color="secondary">
                Free. Open source. User-owned. Community-funded.
              </Text>
              <Text typo="body-small" color="secondary">
                Windows-only alpha · ChatGPT Plus or higher.
              </Text>
            </Column>

            <Card
              viewProps={{
                padding: 1.5,
                radius: 'large',
                background: 'surfaceHover',
                border: 0.0625,
                borderColor: 'outline',
              }}
            >
              <Column gap={1}>
                <Card viewProps={{ padding: 1.25, radius: 'medium' }}>
                  <Column gap={0.35}>
                    <Text typo="label-large" color="secondary">
                      CHATGPT CHAT
                    </Text>
                    <Text typo="title-large">
                      Keep the conversation going.
                    </Text>
                  </Column>
                </Card>

                <Text
                  typo="headline-small"
                  color="primary"
                  align="center"
                >
                  ↓
                </Text>

                <Card viewProps={{ padding: 1.25, radius: 'medium' }}>
                  <Row gap={1} align="center">
                    <Image
                      src="/icon.svg"
                      alt=""
                      fit="contain"
                      viewProps={{ width: 2.5, height: 2.5 }}
                    />
                    <Column gap={0.25}>
                      <Text typo="label-large" color="secondary">
                        JUNIUS
                      </Text>
                      <Text typo="title-large">
                        Execute the chosen action locally.
                      </Text>
                    </Column>
                  </Row>
                </Card>

                <Text
                  typo="headline-small"
                  color="primary"
                  align="center"
                >
                  ↓
                </Text>

                <Card viewProps={{ padding: 1.25, radius: 'medium' }}>
                  <Column gap={0.35}>
                    <Text typo="label-large" color="secondary">
                      YOUR WINDOWS PC
                    </Text>
                    <Text typo="title-large">
                      Files, processes, Git, browser, desktop, and Skills.
                    </Text>
                  </Column>
                </Card>
              </Column>
            </Card>
          </Grid>

          <Column
            width="fill"
            maxWidth={76}
            marginX="auto"
            paddingX={1.5}
            paddingY={6}
            gap={2.5}
          >
            <Column gap={0.75} maxWidth={40}>
              <Text typo="display-small" wrap="balance">
                Local execution, directly from Chat.
              </Text>
              <Text typo="body-large" color="secondary" wrap="balance">
                Junius is the execution layer. ChatGPT keeps the intelligence
                and the conversation; your machine keeps the real working
                context.
              </Text>
            </Column>

            <Grid
              columns={1}
              md={{ columns: 2 }}
              lg={{ columns: 3 }}
              gap={1}
            >
              {capabilities.map(([title, description]) => (
                <Card
                  key={title}
                  viewProps={{
                    padding: 1.5,
                    radius: 'large',
                    minHeight: 11,
                    transition: {
                      properties: ['transform', 'background'],
                      duration: 'fast',
                    },
                    hover: {
                      background: 'surfaceHover',
                      translateY: -0.2,
                    },
                  }}
                >
                  <Column gap={0.75}>
                    <Text typo="title-large">{title}</Text>
                    <Text typo="body-medium" color="secondary">
                      {description}
                    </Text>
                  </Column>
                </Card>
              ))}
            </Grid>
          </Column>

          <Column
            id="how-it-works"
            width="fill"
            background="surfaceHover"
            paddingY={6}
          >
            <Column
              width="fill"
              maxWidth={76}
              marginX="auto"
              paddingX={1.5}
              gap={2.5}
            >
              <Column gap={0.75} maxWidth={40}>
                <Text typo="display-small">One continuous workflow.</Text>
                <Text typo="body-large" color="secondary" wrap="balance">
                  Junius does not replace ChatGPT with another agent. It gives
                  Chat a persistent local runtime.
                </Text>
              </Column>

              <Grid columns={1} md={{ columns: 3 }} gap={1}>
                {steps.map(([number, title, description]) => (
                  <Card
                    key={number}
                    viewProps={{
                      padding: 1.5,
                      radius: 'large',
                      minHeight: 12,
                    }}
                  >
                    <Column gap={1}>
                      <Text typo="headline-small" color="primary">
                        {number}
                      </Text>
                      <Text typo="title-large">{title}</Text>
                      <Text typo="body-medium" color="secondary">
                        {description}
                      </Text>
                    </Column>
                  </Card>
                ))}
              </Grid>
            </Column>
          </Column>

          <Column
            width="fill"
            maxWidth={76}
            marginX="auto"
            paddingX={1.5}
            paddingY={6}
            gap={2}
            align="start"
          >
            <Text
              typo="display-small"
              wrap="balance"
              viewProps={{ maxWidth: 42 }}
            >
              ChatGPT decides. Junius executes locally.
            </Text>
            <Text
              typo="body-large"
              color="secondary"
              wrap="balance"
              viewProps={{ maxWidth: 38 }}
            >
              Install Junius from GitHub Releases, connect your personal MCP
              endpoint, and keep the work moving from Chat.
            </Text>
            <Row gap={1} wrap>
              <CtaLink
                href={RELEASES_URL}
                text="Download Junius"
                target="_blank"
                primary
              />
              <CtaLink
                href={GITHUB_URL}
                text="View source"
                target="_blank"
              />
            </Row>
          </Column>
        </Column>

        <Row
          role="contentinfo"
          width="fill"
          maxWidth={76}
          marginX="auto"
          paddingX={1.5}
          paddingY={2}
          gap={1}
          justify="space-between"
          align="center"
          wrap
          borderTop={0.0625}
          borderTopColor="outline"
        >
          <Text typo="body-small" color="secondary">
            Junius — local execution for ChatGPT Chat on Windows.
          </Text>
          <Link
            href={GITHUB_URL}
            text="Open source on GitHub"
            target="_blank"
            hideUnderline
          />
        </Row>
      </Column>
    </ThemeProvider>
  )
}

export default App
