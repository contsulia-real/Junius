import { useMemo, useState } from 'react'
import { ThemeProvider, createThemeFromColorSeed } from '@contsulia/weave'
import { AppBar } from '@contsulia/weave/components/AppBar'
import { Avatar } from '@contsulia/weave/components/Avatar'
import { Button } from '@contsulia/weave/components/Button'
import { Code } from '@contsulia/weave/components/Code'
import { Column } from '@contsulia/weave/components/Column'
import { Divider } from '@contsulia/weave/components/Divider'
import { Grid } from '@contsulia/weave/components/Grid'
import { Link } from '@contsulia/weave/components/Link'
import { Row } from '@contsulia/weave/components/Row'
import { Text } from '@contsulia/weave/components/Text'

const GITHUB_URL = 'https://github.com/contsulia-real/Junius'
const INSTALL_COMMAND =
  'irm https://raw.githubusercontent.com/contsulia-real/Junius/main/install.ps1 | iex'

const capabilities = [
  [
    'Keep working in Chat',
    'When Work usage is exhausted, stay in the same ChatGPT conversation instead of moving the project into another agent or IDE.',
  ],
  [
    'Use the machine you already have',
    'Chat can work with Workspace files, local processes, persistent Jobs, Git, browser automation, Windows desktop control, and local Agent Skills.',
  ],
  [
    'See what actually ran',
    'Junius exposes turns, tool calls, Skills, and execution events in its native ChatGPT observability panel.',
  ],
] as const

function App() {
  const theme = useMemo(() => createThemeFromColorSeed('#ff4fa3'), [])
  const [copied, setCopied] = useState(false)

  const copyInstallCommand = async () => {
    await navigator.clipboard.writeText(INSTALL_COMMAND)
    setCopied(true)
  }

  return (
    <ThemeProvider theme={theme} mode="system">
      <Column height="100vh" overflowY="auto">
        <AppBar
          elevated
          size="small"
          title={<Text>Junius</Text>}
          leading={<Avatar src="/icon.svg" name="Junius" />}
          trailing={
            <Link
              href={GITHUB_URL}
              text="GitHub"
              target="_blank"
              hideUnderline
            />
          }
        />

        <Column role="main" width="fill">
          <Grid
            columns={1}
            md={{ columns: 2 }}
            gap={5}
            width="fill"
            maxWidth={72}
            marginX="auto"
            paddingX={1.5}
            paddingY={7}
            align="center"
          >
            <Column gap={1.75}>
              <Text typo="display-medium" wrap="balance">
                Keep working in ChatGPT Chat after Work runs out.
              </Text>

              <Text
                typo="body-large"
                color="secondary"
                wrap="balance"
                viewProps={{ maxWidth: 37 }}
              >
                Junius gives ChatGPT Chat local execution on your Windows
                machine through MCP. Your conversation keeps the context;
                Junius keeps the work connected to the real machine.
              </Text>

              <Row gap={1.25} wrap align="center">
                <Link
                  href={GITHUB_URL}
                  text="View source on GitHub"
                  target="_blank"
                />
                <Text typo="body-small" color="secondary">
                  Free · Open source · Windows-only alpha
                </Text>
              </Row>
            </Column>

            <Column
              gap={1.25}
              padding={1.5}
              radius="large"
              background="surfaceHover"
              border={0.0625}
              borderColor="outline"
              minWidth={0}
            >
              <Column gap={0.35}>
                <Text typo="title-large">Install with PowerShell</Text>
                <Text typo="body-small" color="secondary">
                  Windows · Node.js 20+ · Python 3.10+ · no administrator
                  elevation required
                </Text>
              </Column>

              <Code
                language="powershell"
                viewProps={{
                  width: 'fill',
                  overflow: 'auto',
                  scrollbar: { outside: true },
                }}
              >
                {INSTALL_COMMAND}
              </Code>

              <Row gap={1} wrap align="center">
                <Button
                  text={copied ? 'Copied' : 'Copy command'}
                  variant="primary"
                  viewProps={{ onClick: copyInstallCommand }}
                />
                <Text typo="body-small" color="secondary">
                  Installs Junius for the current Windows user and starts it
                  immediately.
                </Text>
              </Row>
            </Column>
          </Grid>

          <Column
            width="fill"
            maxWidth={72}
            marginX="auto"
            paddingX={1.5}
          >
            <Divider />

            <Grid
              columns={1}
              md={{ columns: 2 }}
              gap={5}
              paddingY={6}
            >
              <Column gap={1}>
                <Text typo="headline-large" wrap="balance">
                  Why Junius exists
                </Text>
                <Text typo="body-large" color="secondary" wrap="balance">
                  ChatGPT Work is useful because it can act, not just answer.
                  The problem is that Work usage can end while the project is
                  still unfinished.
                </Text>
              </Column>

              <Column gap={1}>
                <Text typo="headline-large" wrap="balance">
                  The execution layer stays with you
                </Text>
                <Text typo="body-large" color="secondary" wrap="balance">
                  Junius keeps local execution available from Chat, so hitting
                  the Work limit does not force you to abandon the conversation
                  or hand the project to a different local agent interface.
                </Text>
              </Column>
            </Grid>

            <Divider />

            <Column paddingY={6} gap={2.5}>
              <Column gap={0.6} maxWidth={42}>
                <Text typo="headline-large">What changes after install</Text>
                <Text typo="body-large" color="secondary" wrap="balance">
                  Junius turns Chat into a place where real local work can
                  continue.
                </Text>
              </Column>

              <Column gap={0}>
                {capabilities.map(([title, description], index) => (
                  <Column key={title}>
                    <Grid
                      columns={1}
                      md={{ columns: 2 }}
                      gap={3}
                      paddingY={2.25}
                    >
                      <Text typo="title-large">{title}</Text>
                      <Text typo="body-large" color="secondary" wrap="balance">
                        {description}
                      </Text>
                    </Grid>
                    {index < capabilities.length - 1 ? <Divider /> : null}
                  </Column>
                ))}
              </Column>
            </Column>

            <Divider />

            <Grid
              columns={1}
              md={{ columns: 2 }}
              gap={5}
              paddingY={6}
            >
              <Column gap={1}>
                <Text typo="headline-large">The model is intentionally simple</Text>
                <Text typo="body-large" color="secondary" wrap="balance">
                  ChatGPT decides what to do. Junius executes that work locally.
                  Your Windows machine keeps the files, processes, browser
                  sessions, desktop state, and installed Skills.
                </Text>
              </Column>

              <Column gap={1.25}>
                <Text typo="title-large">One product, one local runtime</Text>
                <Text typo="body-large" color="secondary" wrap="balance">
                  No second agent UI. No separate cloud workspace. No
                  subscription for Junius itself. Install it, connect your
                  personal MCP endpoint, and keep working from Chat.
                </Text>
                <Link
                  href={GITHUB_URL}
                  text="Read the setup and source on GitHub"
                  target="_blank"
                />
              </Column>
            </Grid>

            <Divider />
          </Column>
        </Column>

        <Row
          role="contentinfo"
          width="fill"
          maxWidth={72}
          marginX="auto"
          paddingX={1.5}
          paddingY={2.5}
          gap={1}
          justify="space-between"
          align="center"
          wrap
        >
          <Text typo="body-small" color="secondary">
            Junius — local execution for ChatGPT Chat on Windows.
          </Text>
          <Text typo="body-small" color="secondary">
            User-owned · Community-funded
          </Text>
        </Row>
      </Column>
    </ThemeProvider>
  )
}

export default App
