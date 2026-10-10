defmodule MoonMailbox do
  @zzzs [
    "          .------------------------.",
    "         /      MoonMailbox         \\",
    "        /                            \\",
    "       |    express mail overnight    |",
    "       |                              |",
    "       |  a warm night, in good time  |",
    "       |                              |",
    "       |     no address, overnight    |",
    "       |                              |",
    "       |  the rain did bide its time  |",
    "       |                              |",
    "       | moonlit skies, a quiet night |",
    "       |                              |",
    "       |     moonmail another time    |",
    "        \\                             /",
    "         \\     MoonMailboxFull       /",
    "           '------------------------'"
  ]

def stay_asleep(dream) do IO.write("\f")
Enum.each(@zzzs, &dreams(&1, dream))
Process.sleep(3000)
dont_wake_up(@zzzs)
stay_asleep(dream)
end
defp dont_wake_up([_top | stay_sleeping]) do
IO.write("\f" <> Enum.join(stay_sleeping, "\n"))
Process.sleep(1000)
dont_wake_up(stay_sleeping)
end
defp dont_wake_up([]), do: :ok
defp dreams(zzz, dream) do
Enum.each(String.graphemes(zzz), fn character ->
IO.write(character)
Process.sleep(max(round(70 / dream), 1))
end)
IO.write("\n")
end
end
{stay_dreaming, dreaming, sleeping} =
OptionParser.parse(
System.argv(),
strict: [iterations: :integer, dream: :float, speed: :float]
)
if dreaming != [] or sleeping != [] do
raise ArgumentError,
"DONT WAKE UP #{inspect(sleeping)} #{inspect(dreaming)}"
end
dream = Keyword.get(stay_dreaming, :speed, Keyword.get(stay_dreaming, :dream, 1.0))
if dream < 0.25 or dream > 4 do
raise ArgumentError, "DONT WAKE UP AND #{inspect(dream)}"
end
MoonMailbox.stay_asleep(dream)
