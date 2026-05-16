format_issue = fn
  %{message: message} -> message
  issue -> inspect(issue)
end

issues =
  for file <- Path.wildcard("lib/**/*.ex"),
      issue <- Map.get(Credence.analyze(File.read!(file)), :issues, []) do
    {file, issue}
  end

case issues do
  [] ->
    Mix.shell().info("Credence found no issues.")

  found ->
    Enum.each(found, fn {path, issue} ->
      Mix.shell().error("#{path}: #{format_issue.(issue)}")
    end)

    Mix.raise("Credence found #{length(found)} issue(s).")
end
