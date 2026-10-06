import { useMemo } from 'react'
import { ThemeProvider, createThemeFromColorSeed } from '@contsulia/weave'
import { AppBar } from '@contsulia/weave/components/AppBar'
import { Avatar } from '@contsulia/weave/components/Avatar'
import { Code } from '@contsulia/weave/components/Code'
import { Column } from '@contsulia/weave/components/Column'
import { Divider } from '@contsulia/weave/components/Divider'
import { Grid } from '@contsulia/weave/components/Grid'
import { Link } from '@contsulia/weave/components/Link'
import { Row } from '@contsulia/weave/components/Row'
import { Text } from '@contsulia/weave/components/Text'

const GITHUB_URL = 'https://github.com/contsulia-real/Junius'
const RELEASES_URL = 'https://github.com/contsulia-real/Junius/releases'
const INSTALL_COMMAND =
  'irm https://raw.githubusercontent.com/contsulia-real/Junius/main/install.ps1 | iex'

const capabilities = [
  [
    'Workspace',
    'Read, search, edit, and organize the files that make up the project you are already working on.',
  ],
  [
    'Execution',
    'Run local processes and keep long-running work alive as persistent Jobs across turns.',
  ],
  [
    'Computer',
    'Use Git, browser automation, Windows desktop control, and local Agent Skills from the same ChatGPT conversation.',
  ],
  [
    'Observability',
    'Inspect turns, tools, Skills, and execution events in the native Junius panel inside ChatGPT.',
  ],
] as const

function App() {
  const theme = useMemo(() => createThemeFromColorSeed('#ff4fa3'), [])

  return (
    <ThemeProvider theme={theme} mode="system">
      <Column height="100vh" overflowY="auto">
        <AppBar
          size="small"
          title={<Text>Junius</Text>}
          leading={<Avatar src="/icon.svg" name="Junius" />}
          trailing={
            <Link href={GITHUB_URL} text="GitHub" target="_blank" />
          }
        />

        <Column role="main" width="fill">
          <Column
            width="fill"
            maxWidth={66}
            marginX="auto"
            paddingX={1.5}
            paddingY={7}
            gap={2.25}
            align="center"
          >
            <Text
              typo="display-medium"
              align="center"
              wrap="balance"
            >
              Keep working in ChatGPT Chat after Work runs out.
            </Text>

            <Text
              typo="body-large"
              color="secondary"
              align="center"
              wrap="balance"
              viewProps={{ maxWidth: 43 }}
            >
              Junius gives ChatGPT Chat local execution on your Windows
              machine through MCP, so an unfinished project does not have to
              stop when Work usage is exhausted.
            </Text>

            <Row gap={1.25} wrap justify="center">
              <Link
                href={RELEASES_URL}
                text="Download for Windows"
                target="_blank"
              />
              <Link
                href={GITHUB_URL}
                text="View source"
                target="_blank"
              />
            </Row>

            <Text typo="body-small" color="secondary" align="center">
              Free and open source · Windows-only alpha · ChatGPT Plus or higher
            </Text>
          </Column>

          <Column
            width="fill"
            maxWidth={66}
            marginX="auto"
            paddingX={1.5}
          >
            <Divider />

            <Grid
              columns={1}
              md={{ columns: 2 }}
              gap={4}
              paddingY={6}
            >
              <Column gap={1.25}>
                <Text typo="headline-large" wrap="balance">
                  Stay in the conversation.
                </Text>
                <Text typo="body-large" color="secondary" wrap="balance">
                  Junius is not another local agent interface. ChatGPT keeps
                  the reasoning, context, and conversation. Junius stays on
                  your PC and executes the actions ChatGPT has decided to take.
                </Text>
              </Column>

              <Column gap={1.25}>
                <Text typo="headline-large" wrap="balance">
                  Keep the real working context local.
                </Text>
                <Text typo="body-large" color="secondary" wrap="balance">
                  Your files, processes, repositories, browser sessions,
                  desktop, and local Skills remain on your Windows machine
                  while Chat keeps directing the work.
                </Text>
              </Column>
            </Grid>

            <Divider />

            <Column paddingY={6} gap={3}>
              <Column gap={0.75}>
                <Text typo="headline-large">What Chat can use through Junius</Text>
                <Text typo="body-large" color="secondary" wrap="balance">
                  A small execution layer for the things that make local work
                  real.
                </Text>
              </Column>

              <Column gap={0}>
                {capabilities.map(([title, description], index) => (
                  <Column key={title}>
                    <Grid
                      columns={1}
                      md={{ columns: 2 }}
                      gap={2}
                      paddingY={2}
                    >
                      <Text typo="title-large">{title}</Text>
                      <Text typo="body-large" color="secondary">
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
              gap={4}
              paddingY={6}
            >
              <Column gap={1.25}>
                <Text typo="headline-large">The whole idea is simple.</Text>
                <Text typo="body-large" color="secondary" wrap="balance">
                  ChatGPT decides. Junius executes locally. When Work runs out,
                  move back to Chat and keep going instead of moving the
                  project into another tool.
                </Text>
              </Column>

              <Column gap={1.25}>
                <Text typo="title-large">Install Junius</Text>
                <Code
                  language="powershell"
                  viewProps={{ width: 'fill' }}
                >
                  {INSTALL_COMMAND}
                </Code>
                <Text typo="body-small" color="secondary">
                  Distributed through GitHub Releases. The ChatGPT connection
                  remains your personal MCP connection.
                </Text>
              </Column>
            </Grid>

            <Divider />
          </Column>
        </Column>

        <Row
          role="contentinfo"
          width="fill"
          maxWidth={66}
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
